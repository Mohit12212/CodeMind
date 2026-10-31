export const SAMPLES = [
  {
    id: "security_vulnerable",
    title: "Vulnerable Web Service (Python)",
    lang: "python",
    desc: "SQL injection, shell injection, hardcoded credentials, eval, and unclosed resources",
    code: `import sqlite3
import subprocess
import os

API_KEY = "sk-live-91ab33f0c2948b8e"

def find_user(name, cache=[]):
    conn = sqlite3.connect("app.db")
    cur = conn.cursor()
    # SQL injection vulnerability
    cur.execute("SELECT * FROM users WHERE name = '" + name + "'")
    rows = cur.fetchall()
    
    # Insecure dynamic evaluation & unclosed resource
    try:
        log = open("audit.log", "a")
        log.write(eval("'" + name + "'"))
    except:
        pass
        
    # Dangerous shell injection
    subprocess.run("ls -la " + name, shell=True)
    return rows
`
  },
  {
    id: "financial_logic",
    title: "Financial Billing & Discounts (Python)",
    lang: "python",
    desc: "Arithmetic operator bugs, percentage scaling, off-by-one index loops, and negative values",
    code: `def calculate_invoice(items, tax_rate=15, discount=10):
    total = 0
    # Logic error: adds price and quantity instead of multiplying
    for i in range(len(items) + 1):
        item = items[i]
        total = total + item["price"] + item["qty"]
    
    # Percentage error: multiplied directly without dividing by 100
    discount_amount = total * discount
    final_total = total - discount_amount
    
    # Negative salary / price vulnerability
    bonus = process_refund(-500)
    return final_total

def process_refund(amount):
    return amount * 1.05
`
  },
  {
    id: "crypto_deserialization",
    title: "Crypto & Deserialization Flaws (Python)",
    lang: "python",
    desc: "MD5 collision risk, pickle remote code execution, mktemp race condition, and wildcard imports",
    code: `import hashlib
import pickle
import tempfile
from math import *

def store_session(session_data, token):
    # Insecure broken hash algorithm
    token_hash = hashlib.md5(token.encode()).hexdigest()
    
    # Insecure temporary file creation (symlink race condition)
    temp_path = tempfile.mktemp(prefix="sess_")
    
    # Critical: arbitrary code execution via pickle deserialization
    untrusted_obj = pickle.loads(session_data)
    
    # Insecure assertion in production logic
    assert token_hash is not None, "Token must be valid"
    
    return temp_path
`
  },
  {
    id: "production_clean",
    title: "Clean Secure Architecture (Python)",
    lang: "python",
    desc: "Exemplary 100/100 health score with typing, parameterized queries, and context managers",
    code: `import os
import sqlite3
from typing import Any, Dict, List, Optional

DB_PATH = os.environ.get("DATABASE_PATH", "app.db")

def find_user(username: str) -> List[Dict[str, Any]]:
    """Retrieve user records safely using parameterized SQL queries."""
    if not username or not username.strip():
        return []

    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT id, username, email FROM users WHERE username = ?", (username.strip(),))
        return [dict(row) for row in cur.fetchall()]
`
  },
  {
    id: "javascript_vulnerable",
    title: "Vulnerable Express API (JavaScript)",
    lang: "javascript",
    desc: "DOM XSS, eval() dynamic evaluation, shell injection, and loose equality bugs",
    code: `const child_process = require('child_process');

const JWT_SECRET = "super_secret_jwt_token_991823";

function renderUserProfile(container, userInput) {
    // DOM XSS vulnerability
    container.innerHTML = "<div>Welcome " + userInput + "</div>";
    
    // Dangerous dynamic evaluation
    const config = eval("(" + userInput + ")");
    
    // Type coercion issue
    if (userInput == false) {
        console.log("Empty user");
    }
    
    // Command injection
    child_process.exec("ping -c 1 " + userInput);
}
`
  }
];

export const SAMPLE = SAMPLES[0].code;
