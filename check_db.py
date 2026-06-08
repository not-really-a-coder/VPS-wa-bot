import sqlite3
import datetime

db_path = './messages.db'
with sqlite3.connect(db_path) as conn:
    cursor = conn.cursor()
    cursor.execute("SELECT count(*), min(timestamp), max(timestamp) FROM messages WHERE chat_id = '120363423654853310@g.us'")
    count, min_ts, max_ts = cursor.fetchone()
    print(f'Count: {count}')
    if count > 0:
        print(f'Min: {min_ts} ({datetime.datetime.fromtimestamp(min_ts)})')
        print(f'Max: {max_ts} ({datetime.datetime.fromtimestamp(max_ts)})')
    
    today = datetime.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    start = today
    end = start + datetime.timedelta(days=1)
    
    ts_start = int(start.timestamp())
    ts_end = int(end.timestamp())
    print(f'TODAY Range: {ts_start} to {ts_end}')
    cursor.execute("SELECT count(*) FROM messages WHERE chat_id = '120363423654853310@g.us' AND timestamp >= ? AND timestamp < ?", (ts_start, ts_end))
    print(f'Count in TODAY range: {cursor.fetchone()[0]}')
