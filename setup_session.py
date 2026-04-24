"""One-time interactive Telegram session setup.

Run this ONCE on the LXC before starting the service:
    cd /opt/videodrop
    venv/bin/python setup_session.py

It will prompt for your phone number and the verification code Telegram sends.
The session file is saved and reused automatically by the service — no re-login needed.
"""
import yaml
from pathlib import Path
from telethon.sync import TelegramClient

CONFIG_PATH = Path(__file__).parent / "config.yaml"

with open(CONFIG_PATH) as f:
    data = yaml.safe_load(f)

tg = data.get("telegram")
if not tg:
    print("ERROR: No 'telegram:' block found in config.yaml")
    print("Add your api_id and api_hash from https://my.telegram.org first.")
    raise SystemExit(1)

session_file = str(Path(__file__).parent / tg["session_file"])
print(f"Creating Telegram session at: {session_file}")
print("You will be prompted for your phone number and verification code.\n")

with TelegramClient(session_file, tg["api_id"], tg["api_hash"]) as client:
    client.start()
    me = client.get_me()
    print(f"\nLogged in as: {me.first_name} (@{me.username})")
    print(f"Session saved to: {session_file}")
    print("\nDone! You can now start the service:")
    print("  chown videodrop:videodrop", session_file)
    print("  systemctl restart videodrop")
