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
import base64
import io
from dotenv import load_dotenv
from collections import defaultdict
from datetime import datetime, timedelta

load_dotenv()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GATEWAY_URL = os.getenv("GATEWAY_URL", "http://gateway:8000/send")
DB_PATH = "./messages.db"
CONFIG_PATH = "./config.yaml"
MEDIA_DIR = "./media"

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

def wait_for_gateway_ready(max_wait=60):
    """Polls the gateway status endpoint until WhatsApp client is authenticated and ready."""
    status_url = GATEWAY_URL.replace('/send', '/api/status')
    start_time = time.time()
    print("[RECOVERY] Waiting for WhatsApp Gateway to reconnect and authenticate...")
    while time.time() - start_time < max_wait:
        try:
            res = requests.get(status_url, timeout=5)
            if res.status_code == 200:
                data = res.json()
                if data.get('authenticated'):
                    print("[RECOVERY] WhatsApp Gateway is authenticated and ready!")
                    return True
        except Exception:
            pass
        time.sleep(5)
    print(f"[RECOVERY] Gateway did not report authenticated within {max_wait} seconds.")
    return False

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
    
    # Trigger on-demand sync from WhatsApp Gateway before reading DB
    try:
        fetch_url = GATEWAY_URL.replace('/send', '/api/fetch_history')
        sync_payload = {
            "limit": 100,
            "chat_ids": listen_chats
        }
        res_sync = requests.post(fetch_url, json=sync_payload, timeout=25)
        if res_sync.status_code == 200:
            print(f"Pre-summarization sync fetched {res_sync.json().get('saved', 0)} new messages.")
        elif res_sync.status_code == 503:
            print(f"Pre-summarization sync: gateway restarting ({res_sync.text}). Waiting for recovery...")
            if wait_for_gateway_ready(max_wait=60):
                res_sync = requests.post(fetch_url, json=sync_payload, timeout=25)
                if res_sync.status_code == 200:
                    print(f"Post-recovery sync fetched {res_sync.json().get('saved', 0)} new messages.")
        else:
            print(f"Pre-summarization sync returned status {res_sync.status_code}: {res_sync.text}")
    except Exception as e:
        print(f"Pre-summarization sync skipped/timed out: {e}")

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
            # Check if this message has an image (either media_path file or raw base64 JPEG in body)
            is_b64_img = isinstance(m['raw_body'], str) and m['raw_body'].startswith('/9j/')
            is_image = (bool(m['media_path']) or is_b64_img) and str(m['raw_body']) not in ('[Sticker Image]', '[Sticker]')
            
            if is_image:
                photo_count = 1
                caption = m['body_str'] if (m['body_str'] != '[Image]' and not is_b64_img) else ""
                vision_image = m['media_path']
                vision_b64 = m['raw_body'] if is_b64_img else None
                
                j = i + 1
                while j < len(valid_msgs):
                    next_m = valid_msgs[j]
                    next_is_b64 = isinstance(next_m['raw_body'], str) and next_m['raw_body'].startswith('/9j/')
                    next_is_image = (bool(next_m['media_path']) or next_is_b64) and str(next_m['raw_body']) not in ('[Sticker Image]', '[Sticker]')
                    if next_is_image:
                        time_diff = next_m['ts'] - m['ts']
                        if time_diff <= 60:
                            photo_count += 1
                            if next_m['body_str'] != '[Image]' and not next_is_b64:
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
                    "media_path": vision_image,
                    "media_b64": vision_b64
                })
                i = j
            else:
                grouped_msgs.append({
                    "date": m['date_str'],
                    "timestamp": m['time_str'],
                    "content": m['body_str'],
                    "media_path": m['media_path'],
                    "media_b64": None
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
            # Load image from file path or decode base64
            img = None
            if gm['media_path'] and os.path.exists(gm['media_path']):
                try:
                    img = PIL.Image.open(gm['media_path'])
                except Exception as e:
                    print(f"Failed to load image from file {gm['media_path']}: {e}")
            elif gm.get('media_b64'):
                try:
                    img_data = base64.b64decode(gm['media_b64'])
                    img = PIL.Image.open(io.BytesIO(img_data))
                except Exception as e:
                    print(f"Failed to decode base64 image: {e}")

            if img is not None:
                try:
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
                    print(f"Failed to process image for vision: {e}")
        
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
                    "text": summary_text,
                    "routeId": route_id
                }
                
                max_retries = 3
                sent_successfully = False
                for attempt in range(max_retries):
                    try:
                        res = requests.post(GATEWAY_URL, json=payload, timeout=30)
                        if res.status_code == 200:
                            print(f"Successfully sent summary to target chat {target}.")
                            sent_successfully = True
                            break
                        else:
                            print(f"Attempt {attempt+1} failed to send summary to {target}: {res.text}")
                            # If gateway reported it is restarting due to a degraded session, wait for it to recover
                            try:
                                err_json = res.json()
                                if err_json.get('restarting'):
                                    print("[RECOVERY] Gateway is restarting. Pausing before next retry...")
                                    wait_for_gateway_ready(max_wait=60)
                                    continue
                            except Exception:
                                pass
                    except Exception as e:
                        print(f"Attempt {attempt+1} error sending summary to {target}: {e}")
                    
                    if attempt < max_retries - 1:
                        print("Retrying in 10 seconds...")
                        time.sleep(10)
                
                if not sent_successfully:
                    print(f"Failed to send summary to {target} after {max_retries} attempts.")
                
    except Exception as e:
        print(f"Error calling Gemini API or sending message: {e}")

def run_cleanup():
    """Runs daily maintenance: purges messages older than 30 days and removes orphaned media files."""
    try:
        now = int(time.time())
        thirty_days_ago = now - (30 * 24 * 60 * 60)
        one_day_ago = now - (24 * 60 * 60)
        
        # 1. Clean DB messages older than 30 days & their attached media
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id, media_path FROM messages WHERE timestamp < ?", (thirty_days_ago,))
            old_msgs = cursor.fetchall()
            for old_id, old_media in old_msgs:
                if old_media:
                    basename = os.path.basename(old_media)
                    for candidate_path in [old_media, os.path.join(MEDIA_DIR, basename)]:
                        if os.path.exists(candidate_path):
                            try:
                                os.remove(candidate_path)
                            except Exception:
                                pass
            cursor.execute("DELETE FROM messages WHERE timestamp < ?", (thirty_days_ago,))
            conn.commit()

            # 2. Collect all active media files referenced in DB
            cursor.execute("SELECT media_path FROM messages WHERE media_path IS NOT NULL")
            active_media_names = {os.path.basename(r[0]) for r in cursor.fetchall() if r[0]}

        # 3. Clean orphaned files in media/ older than 24 hours
        if os.path.isdir(MEDIA_DIR):
            orphans_removed = 0
            with os.scandir(MEDIA_DIR) as it:
                for entry in it:
                    if entry.is_file() and entry.name not in active_media_names:
                        try:
                            if entry.stat().st_mtime < one_day_ago:
                                os.remove(entry.path)
                                orphans_removed += 1
                        except Exception:
                            pass
            if orphans_removed > 0:
                print(f"[CLEANUP] Removed {orphans_removed} orphaned media files.")

        print(f"[CLEANUP] Daily cleanup completed at {datetime.now().isoformat()}")
    except Exception as e:
        print(f"[CLEANUP] Error during cleanup: {e}")

def start_scheduler():
    last_mtime = 0
    # Schedule automatic maintenance daily at 03:00
    schedule.every().day.at("03:00").do(run_cleanup)
    print("Scheduled daily cleanup maintenance at 03:00")
    
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
            
            # Re-register daily maintenance cleanup
            schedule.every().day.at("03:00").do(run_cleanup)

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
