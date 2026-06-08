import os
import time
import schedule
import sqlite3
import requests
import json
import yaml

def str_presenter(dumper, data):
    if '\n' in data:
        return dumper.represent_scalar('tag:yaml.org,2002:str', data, style='|')
    return dumper.represent_scalar('tag:yaml.org,2002:str', data)

yaml.add_representer(str, str_presenter)
yaml.representer.SafeRepresenter.add_representer(str, str_presenter)
import google.generativeai as genai
import PIL.Image
from dotenv import load_dotenv
from collections import defaultdict
from datetime import datetime, timedelta

load_dotenv()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GATEWAY_URL = os.getenv("GATEWAY_URL", "http://gateway:8000/send")
DB_PATH = "./messages.db"
CONFIG_PATH = "./config.yaml"

if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)

def get_time_range(time_range_str):
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    if time_range_str == 'TODAY':
        start = today
        end = start + timedelta(days=1)
    elif time_range_str == 'YESTERDAY':
        start = today - timedelta(days=1)
        end = today
    elif time_range_str.startswith('TODAY-'):
        try:
            days_back = int(time_range_str.split('-')[1])
            start = today - timedelta(days=days_back)
            end = start + timedelta(days=1)
        except:
            start = today - timedelta(days=1)
            end = today
    else:
        # Default to yesterday
        start = today - timedelta(days=1)
        end = today
    return int(start.timestamp()), int(end.timestamp()), start

def load_config():
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            return yaml.safe_load(f)
    except Exception as e:
        print(f"Error loading config.yaml: {e}")
        return None

def run_summarization(route_id, time_range_override=None, dry_run=False):
    print(f"[{datetime.now()}] Running summarization for route: {route_id}")
    if not GEMINI_API_KEY:
        print("GEMINI_API_KEY not configured. Skipping.")
        return
        
    config_data = load_config()
    if not config_data:
        return
        
    route = next((r for r in config_data.get('routes', []) if r['id'] == route_id), None)
    if not route:
        print(f"Route {route_id} not found in config.")
        return

    prompt_id = route.get('prompt_id')
    prompt_obj = config_data.get('prompts', {}).get(prompt_id, {})
    
    # Backwards compatibility for string prompts
    if isinstance(prompt_obj, str):
        prompt_template = prompt_obj
        prompt_model = 'gemini-3.1-flash-lite'
        prompt_temp = 0.7
    else:
        prompt_template = prompt_obj.get('text', "Summarize:\n{chat_text}")
        prompt_model = prompt_obj.get('model', 'gemini-3.1-flash-lite')
        prompt_temp = float(prompt_obj.get('temperature', 0.7))

    # Get system prompt
    sys_prompt_obj = config_data.get('prompts', {}).get('system_prompt', {})
    if isinstance(sys_prompt_obj, str):
        sys_prompt_text = sys_prompt_obj
    else:
        sys_prompt_text = sys_prompt_obj.get('text', "You are a strict assistant summarizing WhatsApp chats. You MUST output the final summary entirely in Russian (Русский язык). Use Hebrew words only if absolutely necessary.")
    
    model = genai.GenerativeModel(
        prompt_model,
        system_instruction=sys_prompt_text
    )
    
    listen_chats = route.get('listen_chats', [])
    target_chats = route.get('target_chats', [])
    if not listen_chats or not target_chats:
        print("Missing listen_chats or target_chats.")
        return
        
    time_range_str = time_range_override or route.get('time_range', 'YESTERDAY')
    ts_start, ts_end, start_date = get_time_range(time_range_str)
    
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()

            placeholders = ','.join('?' for _ in listen_chats)
            query = f"SELECT id, message_id, chat_id, chat_name, body, timestamp, media_path FROM messages WHERE timestamp >= ? AND timestamp < ? AND chat_id IN ({placeholders}) ORDER BY timestamp ASC"
            
            cursor.execute(query, (ts_start, ts_end, *listen_chats))
            rows = cursor.fetchall()
            
            if not rows:
                print(f"No messages found for route {route_id}.")
                return
            
            chats_data = defaultdict(list)
            for row in rows:
                msg_id, message_id, chat_id, chat_name, body, ts, media_path = row
                try:
                    dt = datetime.fromtimestamp(ts)
                    time_str = dt.strftime('%H:%M')
                    date_str = dt.strftime('%Y-%m-%d')
                except:
                    time_str = "Unknown"
                    date_str = "Unknown"
                    
                chats_data[chat_id].append({
                    "chat_name": chat_name,
                    "date_str": date_str,
                    "time_str": time_str,
                    "body_str": str(body) if body is not None else "",
                    "media_path": media_path,
                    "raw_body": body,
                    "ts": ts
                })
    except Exception as e:
        print(f"Database error during run_summarization: {e}")
        return

    # Bundle all chats into a single massive JSON array
    content_payload = []
    chat_history_json = []
    
    for chat_id, msgs in chats_data.items():
        valid_msgs = [m for m in msgs if not str(m['raw_body']).startswith("[unknown]")]
        if not valid_msgs: continue
        
        grouped_msgs = []
        i = 0
        while i < len(valid_msgs):
            m = valid_msgs[i]
            is_image = bool(m['media_path']) and str(m['raw_body']) not in ('[Sticker Image]', '[Sticker]')
            
            if is_image:
                photo_count = 1
                caption = m['body_str'] if m['body_str'] != '[Image]' else ""
                vision_image = m['media_path']
                
                j = i + 1
                while j < len(valid_msgs):
                    next_m = valid_msgs[j]
                    next_is_image = bool(next_m['media_path']) and str(next_m['raw_body']) not in ('[Sticker Image]', '[Sticker]')
                    if next_is_image:
                        time_diff = next_m['ts'] - m['ts']
                        if time_diff <= 60:
                            photo_count += 1
                            if next_m['body_str'] != '[Image]':
                                caption += (" " + next_m['body_str'] if caption else next_m['body_str'])
                            j += 1
                        else:
                            break
                    else:
                        break
                
                content = caption.strip()
                if photo_count > 1:
                    content = f"[{photo_count} photos attached] " + content
                elif photo_count == 1:
                    content = "[1 photo attached] " + content
                
                grouped_msgs.append({
                    "date": m['date_str'],
                    "timestamp": m['time_str'],
                    "content": content.strip(),
                    "media_path": vision_image
                })
                i = j
            else:
                grouped_msgs.append({
                    "date": m['date_str'],
                    "timestamp": m['time_str'],
                    "content": m['body_str'],
                    "media_path": m['media_path']
                })
                i += 1

        chat_name = valid_msgs[0]['chat_name']
        chat_obj = {
            "chat_name": chat_name,
            "messages": []
        }
        for gm in grouped_msgs:
            chat_obj["messages"].append({
                "date": gm['date'],
                "timestamp": gm['timestamp'],
                "content": gm['content']
            })
            if gm['media_path'] and os.path.exists(gm['media_path']):
                try:
                    img = PIL.Image.open(gm['media_path'])
                    if img.mode in ('RGBA', 'P', 'LA'):
                        background = PIL.Image.new('RGB', img.size, (255, 255, 255))
                        if img.mode == 'RGBA' or img.mode == 'LA':
                            background.paste(img, mask=img.split()[-1])
                        else:
                            background.paste(img)
                        img = background
                    else:
                        img = img.convert('RGB')
                    content_payload.append(img)
                except Exception as e:
                    print(f"Failed to load image for vision: {e}")
        
        chat_history_json.append(chat_obj)

    if not chat_history_json:
        print("No valid messages after filtering.")
        conn.close()
        return

    chat_history_str = json.dumps(chat_history_json, ensure_ascii=False, indent=2)
    print(f"JSON Payload for Gemini:\n{chat_history_str}")
    
    # Replace description and chat_text in prompt
    route_desc = route.get('description', '')
    final_prompt = prompt_template.replace("{chat_description}", route_desc).replace("{chat_text}", "")
    
    content_payload.insert(0, final_prompt)
    content_payload.append(chat_history_str)
    content_payload.append("\n\nCRITICAL REMINDER: Follow all rules from the prompt. You MUST write the final summary entirely in Russian. Translate all Hebrew text to Russian.")
    
    try:
        response = model.generate_content(
            content_payload,
            generation_config=genai.types.GenerationConfig(
                temperature=prompt_temp,
            ),
            safety_settings=[
                {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"}
            ]
        )
        date_display = start_date.strftime('%d.%m')
        summary_text = f"*Сводка сообщений за {date_display}:*\n\n{response.text}"
        
        if dry_run:
            print("\n---SUMMARY_START---")
            print(summary_text)
            print("---SUMMARY_END---\n")
        else:
            # Send via Gateway to all target chats
            for target in target_chats:
                payload = {
                    "chatId": target,
                    "text": summary_text
                }
                res = requests.post(GATEWAY_URL, json=payload)
                if res.status_code == 200:
                    print(f"Successfully sent summary to target chat {target}.")
                else:
                    print(f"Failed to send summary to {target}: {res.text}")
                
    except Exception as e:
        print(f"Error calling Gemini API or sending message: {e}")

    # Cleanup 30 days
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            thirty_days_ago = int(time.time()) - (30 * 24 * 60 * 60)
            cursor.execute("SELECT id, media_path FROM messages WHERE timestamp < ?", (thirty_days_ago,))
            old_msgs = cursor.fetchall()
            for old_id, old_media in old_msgs:
                if old_media and os.path.exists(old_media):
                    try:
                        os.remove(old_media)
                    except Exception:
                        pass
            cursor.execute("DELETE FROM messages WHERE timestamp < ?", (thirty_days_ago,))
            conn.commit()
    except Exception as e:
        print(f"Database cleanup error: {e}")

def start_scheduler():
    last_mtime = 0
    while True:
        try:
            mtime = os.path.getmtime(CONFIG_PATH)
        except OSError:
            mtime = 0
            
        if mtime > last_mtime:
            print("Config changed. Reloading schedules...")
            last_mtime = mtime
            config_data = load_config()
            schedule.clear()
            
            if config_data and 'routes' in config_data:
                for route in config_data['routes']:
                    route_id = route.get('id')
                    
                    times = route.get('schedule_times', [])
                    for st in times:
                        try:
                            schedule.every().day.at(st).do(run_summarization, route_id=route_id)
                            print(f"Scheduled route '{route_id}' at {st}")
                        except schedule.ScheduleValueError as e:
                            print(f"Invalid time format in schedule_times: '{st}' for route {route_id}. Error: {e}")
            
        schedule.run_pending()
        time.sleep(30)

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "--run-now":
        print("Manual trigger activated.")
        config_data = load_config()
        dry_run = "--dry-run" in sys.argv
        args = [a for a in sys.argv if a != "--dry-run"]
        if config_data and 'routes' in config_data:
            route_id_arg = args[2] if len(args) > 2 else None
            time_range_override = args[3] if len(args) > 3 else None
            for route in config_data['routes']:
                if route_id_arg and route.get('id') != route_id_arg:
                    continue
                run_summarization(route.get('id'), time_range_override=time_range_override, dry_run=dry_run)
        else:
            print("No routes found in config.yaml.")
    else:
        start_scheduler()
