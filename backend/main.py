"""CodeMind backend: Advanced static analysis + Multi-file project scan + Execution sandbox + AI Copilot."""
import ast
import builtins
import difflib
import io
import json
import math
import contextvars
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import tokenize
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, JSONResponse, HTMLResponse
from pydantic import BaseModel

DB_PATH = Path(__file__).with_name("codemind_v2.db")
DEFAULTS = {
    "base_url": "http://127.0.0.1:1234/v1",
    "api_key": "",          # optional auth token for OpenAI / Groq / OpenRouter
    "model": "",            # default model for every task
    "review_model": "",     # optional override for reviewing
    "refactor_model": "",   # optional override for refactor + quick fix
    "timeout": 240,
}
SEVERITIES = ["critical", "high", "medium", "low"]
SEV_WEIGHT = {"critical": 25, "high": 15, "medium": 8, "low": 3}

# ───────────────────────── storage ─────────────────────────

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with closing(db()) as c, c:
        c.execute("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)")
        c.execute(
            """CREATE TABLE IF NOT EXISTS history(
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, language TEXT, model TEXT,
                code TEXT, analysis TEXT, refactor TEXT, score_before INTEGER, score_after INTEGER)"""
        )


def get_settings():
    s = dict(DEFAULTS)
    with closing(db()) as c:
        for row in c.execute("SELECT key, value FROM settings"):
            if row["key"] in DEFAULTS:
                try:
                    s[row["key"]] = json.loads(row["value"])
                except Exception:
                    s[row["key"]] = row["value"]
    return s


def save_settings(patch):
    with closing(db()) as c, c:
        for k, v in patch.items():
            if k in DEFAULTS and v is not None:
                c.execute("INSERT OR REPLACE INTO settings VALUES(?,?)", (k, json.dumps(v)))


# ───────────────────────── local LLM layer ─────────────────────────

CALLS = contextvars.ContextVar("calls", default=None)
DROPS = contextvars.ContextVar("drops", default=None)


def note_drop(n):
    d = DROPS.get()
    if d is not None and n > 0:
        d.append(n)


def tick():
    c = CALLS.get()
    if c is not None:
        c.append(1)


class LLMError(Exception):
    pass


TASKS = {
    "review":   {"temperature": 0.1, "max_tokens": 3200, "model_key": "review_model"},
    "refactor": {"temperature": 0.2, "max_tokens": 4000, "model_key": "refactor_model"},
    "quick":    {"temperature": 0.1, "max_tokens": 1200, "model_key": "review_model"},
    "qverify":  {"temperature": 0.0, "max_tokens": 250,  "model_key": "review_model"},
    "verify":   {"temperature": 0.0, "max_tokens": 900,  "model_key": "review_model"},
    "fix":      {"temperature": 0.1, "max_tokens": 4000, "model_key": "refactor_model"},
    "test":     {"temperature": 0.2, "max_tokens": 4000, "model_key": "refactor_model"},
    "explain":  {"temperature": 0.2, "max_tokens": 3200, "model_key": "review_model"},
    "copilot":  {"temperature": 0.3, "max_tokens": 3000, "model_key": "review_model"},
    "commit":   {"temperature": 0.2, "max_tokens": 800,  "model_key": "refactor_model"},
}


def pick_model(task, settings, override=None):
    return override or settings.get(TASKS[task]["model_key"]) or settings["model"]


def get_headers(settings):
    headers = {"Content-Type": "application/json"}
    if settings.get("api_key"):
        headers["Authorization"] = f"Bearer {settings['api_key']}"
    return headers


async def fetch_models(base_url, api_key=""):
    url = base_url.rstrip("/")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    models_url = url + "/models" if not url.endswith("/models") else url
    async with httpx.AsyncClient(timeout=6) as client:
        try:
            r = await client.get(models_url, headers=headers)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, dict) and "data" in data:
                    ids = [m.get("id", "") for m in data.get("data", [])]
                    return sorted(i for i in ids if i and "embed" not in i.lower())
                elif isinstance(data, dict) and "models" in data:
                    ids = [m.get("name", m.get("id", "")) for m in data.get("models", [])]
                    return sorted(i for i in ids if i and "embed" not in i.lower())
        except Exception:
            pass

        root_url = re.sub(r"/v1/?$", "", url)
        try:
            r = await client.get(root_url + "/api/tags", timeout=4)
            if r.status_code == 200:
                models = [m.get("name", "") for m in r.json().get("models", [])]
                return sorted(m for m in models if m)
        except Exception:
            pass

    raise LLMError(f"Cannot reach model provider at {url}")


async def chat(task, system, user, model, conversation=None):
    s = get_settings()
    if not model:
        raise LLMError("No model selected. Choose one from detected models or enter model name in Settings.")
    cfg = TASKS[task]

    messages = [{"role": "system", "content": system}]
    if conversation:
        messages.extend(conversation)
    messages.append({"role": "user", "content": user})

    payload = {
        "model": model,
        "messages": messages,
        "temperature": cfg["temperature"],
        "max_tokens": cfg["max_tokens"],
        "stream": False,
    }
    url = s["base_url"].rstrip("/")
    completions_url = url + "/chat/completions" if not url.endswith("/chat/completions") else url
    headers = get_headers(s)

    try:
        async with httpx.AsyncClient(timeout=s["timeout"]) as client:
            r = await client.post(completions_url, json=payload, headers=headers)
        r.raise_for_status()
        res = r.json()
        text = res["choices"][0]["message"]["content"] or ""
    except httpx.ConnectError:
        raise LLMError(f"Cannot reach LLM server at {url}. Ensure LM Studio, Ollama, or Bionic is active.")
    except httpx.TimeoutException:
        raise LLMError("The model took too long to answer. Try a smaller model or increase timeout in Settings.")
    except httpx.HTTPStatusError as e:
        raise LLMError(f"Provider returned HTTP {e.response.status_code}: {e.response.text[:220]}")
    except (KeyError, IndexError, ValueError):
        raise LLMError("Provider sent a response in an unrecognized format.")
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()


def parse_json(text):
    text = re.sub(r"```(?:json)?", "", text)
    a, b = text.find("{"), text.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        return json.loads(text[a : b + 1])
    except json.JSONDecodeError:
        return None


def extract_code(text):
    blocks = re.findall(r"```[\w+#.-]*\n(.*?)```", text, flags=re.S)
    if blocks:
        return max(blocks, key=len).strip("\n")
    if "```" in text:
        return re.sub(r"^```[\w+#.-]*\n", "", text[text.find("```") :]).strip("\n")
    return text.strip("\n")


REVIEW_SYS = """You review code for bugs that make it give WRONG RESULTS, CRASH, or cause SECURITY BREACHES. Work in two steps.
TRACE: walk through the code with small example values and check each calculation, validation, and condition. Look for: logic flaws, unhandled exceptions, SQL/shell/code injection, arithmetic mistakes, off-by-one errors, state mutation bugs, and resource leaks.
ISSUES: report a problem ONLY if you can name a concrete input and the wrong output or crash it causes in this exact code. Put that input and result in the WHAT IS WRONG column.
Do NOT report: styling, variable naming preference, missing docstrings, or code that already works properly.
Report at most 6 problems, most critical first.
Format, one per line:
LINE | SEVERITY | CATEGORY | TITLE | WHAT IS WRONG (input and wrong result) | HOW TO FIX | CODE (copy exact line)
SEVERITY is critical, high, medium or low. CATEGORY is logic, security, resource or error-handling. LINE is the line number shown.
If the code is correct, write: ISSUES: NONE."""

REVIEW_QUICK_SYS = """You are a fast code reviewer. Find the problems that stop this code from running or cause security or logic failures.
Skip style, naming, docstrings, and minor suggestions.
Reply with one problem per line and nothing else:
LINE | SEVERITY | CATEGORY | TITLE | WHAT IS WRONG | HOW TO FIX | CODE (copy exact line)
SEVERITY is critical, high, medium or low. CATEGORY is logic, security, resource or error-handling. If no problems, reply NONE."""

REPAIR_SYS = """You are a repair engine. Make the user's code run correctly and securely with minimal necessary changes.
Fix syntax errors, undefined names, crashes, security holes, and listed bugs. Keep names, docstrings, and structure intact.
Return the complete corrected code in ONE fenced code block and nothing else."""

VERIFY_SYS = """You are a skeptical bug triager. For each numbered finding, decide whether the code AS WRITTEN really gives a wrong result or crashes.
DROP it if it is about style, naming, suggestion, or if the code actually handles the case correctly.
KEEP it only if you can see the bug in the code.
Reply with one line per finding: NUMBER | KEEP or DROP | short reason"""

NOISE_RE = re.compile(r"(naming|readab|hard-?coded|magic number|docstring|type hint|comment|redundant|unnecessary|"
                      r"print statement|more descriptive|flexib|variable name)", re.I)

REFACTOR_SYS = """You are an expert refactoring engine. Rewrite the user's code so it is secure, robust, clean, and idiomatic while preserving public signatures and behaviour.
Fix: SQL injection, hardcoded credentials, eval/exec, shell=True, insecure hashes/tempfiles, bare exceptions, unclosed connections, and high complexity.
Return the complete file in ONE fenced code block and nothing else."""

FIX_SYS = """You fix exactly one problem in the user's code. Change only what that problem needs; leave every other line identical.
Return the complete file in ONE fenced code block and nothing else."""

TEST_SYS = """You are a senior software test engineer. Generate a comprehensive, production-grade test suite for the given code.
Use pytest for Python, or Jest for JavaScript/TypeScript.
Include:
1. Normal happy-path tests.
2. Edge cases (boundary values, empty input, None/null, extremes).
3. Exception & failure test cases.
4. Clean descriptive test names and assertions.
Return the complete test file in ONE fenced code block and nothing else."""

EXPLAIN_SYS = """You are an expert software architect and security auditor.
Analyze the provided code and generate a clear, structured Markdown explanation with:
### 1. Executive Summary
Brief high-level explanation of what the code does and its primary purpose.
### 2. Architecture & Data Flow
Step-by-step breakdown of how data enters, gets processed, and exits.
### 3. Security & Threat Modeling
Specific threat model: injection vectors, data exposure, resource management, and risk rating.
### 4. Performance & Reliability Observations
Time/space complexity, potential bottlenecks, and concurrency or scaling risks.
### 5. Architectural Recommendations
Key best practices for maintainability, typing, and resilience."""

COPILOT_SYS = """You are CodeMind Copilot, an expert AI software architect and security reviewer.
You have access to the user's source code and current static analysis findings.
Answer questions, provide actionable engineering solutions, explain vulnerabilities, or refactor functions.
When providing code modifications or snippets, provide the code in fenced code blocks (```python or ```javascript).
Be concise, accurate, and direct."""

COMMIT_SYS = """You generate concise, professional Conventional Commit messages for code refactorings.
Output format:
type(scope): concise summary in imperative mood

- Detailed bullet point 1
- Detailed bullet point 2

Types: fix, refactor, perf, sec (security).
Output ONLY the commit message and nothing else."""

CATEGORY_RULE = {"resource": "RESOURCE", "error-handling": "EXCEPT"}


def parse_issue_text(text):
    has_marker = re.search(r"ISSUES\s*:", text, re.I)
    tail = re.split(r"ISSUES\s*:", text, flags=re.I)[-1] if has_marker else text
    out = []
    for raw in tail.splitlines():
        line = raw.strip().strip("`").lstrip("-*\u2022| ").strip()
        parts = [x.strip(" *`") for x in line.split("|")]
        if len(parts) >= 5 and re.search(r"\d+", parts[0]):
            out.append({
                "line": re.search(r"\d+", parts[0]).group(),
                "severity": parts[1].lower(),
                "category": parts[2].lower(),
                "title": parts[3],
                "detail": parts[4],
                "suggestion": parts[5] if len(parts) > 5 else "",
                "evidence": parts[6] if len(parts) > 6 else "",
            })
    if out:
        return out
    if re.search(r"^\W*NONE\W*$", tail, re.I | re.M):
        return []
    data = parse_json(text)
    if isinstance(data, dict) and isinstance(data.get("issues"), list):
        return [i for i in data["issues"] if isinstance(i, dict)]
    return None


def split_units(code, lang):
    if lang != "python" or len(code.splitlines()) <= 35:
        return None, ""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        try:
            tree = ast.parse(repair_colons(code)[0])
        except SyntaxError:
            return None, ""
    units, top, outline = [], [], []

    def span(n):
        return min([n.lineno] + [d.lineno for d in getattr(n, "decorator_list", [])]), n.end_lineno

    def sig(fn):
        return f"{fn.name}({', '.join(a.arg for a in fn.args.args)})"

    for n in tree.body:
        if isinstance(n, ast.ClassDef):
            ms = [m for m in n.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef))]
            outline.append(f"class {n.name}: " + ", ".join(sig(m) for m in ms))
            units += [[span(m)] for m in ms]
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            outline.append("def " + sig(n))
            units.append([span(n)])
        else:
            top.append(span(n))
    if top:
        units.append(top)
    if not 2 <= len(units) <= 8:
        return None, ""
    return units, "\n".join(outline)


def numbered(lines, ranges):
    return "\n...\n".join("\n".join(f"{i}: {lines[i - 1]}" for i in range(a, b + 1)) for a, b in ranges)


async def ask_issues(user, model, task="review", system=None):
    system = system or REVIEW_SYS
    tick()
    items = parse_issue_text(await chat(task, system, user, model))
    if items is None:
        tick()
        items = parse_issue_text(await chat(
            task, system,
            user + "\n\nReply with the ISSUES list only: one problem per line in format LINE | SEVERITY | CATEGORY | TITLE | WHAT IS WRONG | HOW TO FIX | CODE, or NONE.",
            model,
        ))
    return items


async def verify(code, items, model, brief=False):
    lines = code.splitlines()
    listing = "\n".join(f"{i}. line {it['line']}: {it['title']} - {it['detail']}" for i, it in enumerate(items, 1))
    tick()
    system = VERIFY_SYS + ("\nReply with ONLY lines like: NUMBER | KEEP or DROP." if brief else "")
    text = await chat("qverify" if brief else "verify", system, f"Code:\n{numbered(lines, [(1, max(1, len(lines)))])}\n\nFindings:\n{listing}", model)
    verdicts = {int(m.group(1)): m.group(2).upper() for m in re.finditer(r"^\W*(\d+)\W+(KEEP|DROP)", text, re.I | re.M)}
    if not verdicts:
        return items
    return [it for i, it in enumerate(items, 1) if verdicts.get(i, "KEEP") == "KEEP"]


async def ai_review(code, lang, static_issues, model, mode="deep"):
    lines = code.splitlines()
    n_lines = max(1, len(lines))
    known = "\n".join(f"- line {i['line']}: {i['title']}" for i in static_issues[:15])
    known = f"Already detected, do not repeat:\n{known}\n" if known else ""
    units, outline = split_units(code, lang)
    if mode == "quick":
        units = None
    system, task = (REVIEW_QUICK_SYS, "quick") if mode == "quick" else (REVIEW_SYS, "review")
    if units:
        prompts = [f"Language: {lang}\nFile outline (review only the part below):\n{outline}\n{known}\n"
                   f"Review this part. Line numbers are real:\n{numbered(lines, r)}" for r in units]
    else:
        prompts = [f"Language: {lang}\n{known}\nCode:\n{numbered(lines, [(1, n_lines)])}"]
    raw, ok = [], False
    for u in prompts:
        try:
            items = await ask_issues(u, model, task, system)
        except LLMError:
            if not ok:
                raise
            break
        if items is not None:
            ok = True
            raw += items
    if not ok:
        return [], "unparsed"
    out, seen = [], set()
    for k, it in enumerate(raw):
        if not it.get("title"):
            continue
        try:
            line = max(int(it.get("line", 1)), 1)
        except (TypeError, ValueError):
            line = 1
        sev = str(it.get("severity", "")).lower()
        sev = sev if sev in SEVERITIES else "medium"
        cat = str(it.get("category", "logic")).lower()
        rule = CATEGORY_RULE.get(cat)
        if cat in ("style", "performance") or (cat != "security" and NOISE_RE.search(str(it["title"]))):
            continue
        key = (line, str(it["title"]).lower())
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "id": f"ai-{k}-{line}", "line": line, "severity": sev, "category": cat,
            "title": str(it["title"])[:90], "detail": str(it.get("detail", ""))[:400],
            "suggestion": str(it.get("suggestion", ""))[:400], "evidence": str(it.get("evidence", ""))[:200], "source": "ai",
            "rule": rule, "standards": [], "sources": ["model"], "confidence": "opinion",
        })
    if out:
        try:
            out = await verify(code, out, model, brief=(mode == "quick"))
        except LLMError:
            pass
    note_drop(len(raw) - len(out[:8]))
    return out[:8], "ok"


# ───────────────────────── static analysis (Python) ─────────────────────────

RULES = {
    "SQLI": ("critical", "security", "SQL built from strings",
             "The query text is assembled with string formatting, allowing SQL injection.",
             "Pass values as parameterized arguments, e.g. cur.execute('... WHERE id = ?', (user_id,)).",
             ["OWASP A03:2021", "CWE-89"]),
    "SHELL": ("high", "security", "Shell command execution",
              "Executing commands through a system shell lets untrusted input inject arbitrary commands.",
              "Call subprocess.run([...]) with an argument list and shell=False.",
              ["OWASP A03:2021", "CWE-78"]),
    "SECRET": ("high", "security", "Hardcoded credential/secret",
               "A sensitive key, token, or credential is hardcoded in the source.",
               "Read it from an environment variable (os.environ) or secrets manager.",
               ["OWASP A07:2021", "CWE-798"]),
    "EVAL": ("critical", "security", "Dynamic code execution",
             "eval() or exec() executes arbitrary untrusted strings as code.",
             "Use ast.literal_eval for data or a safe dictionary lookup table.",
             ["OWASP A05:2021", "CWE-95"]),
    "INSECHASH": ("high", "security", "Insecure cryptographic hash",
                  "MD5 or SHA-1 is cryptographically broken and vulnerable to collision attacks.",
                  "Use hashlib.sha256(), hashlib.sha3_256(), or bcrypt/argon2 for password hashing.",
                  ["OWASP A02:2021", "CWE-327", "CWE-328"]),
    "INSECTEMP": ("high", "security", "Insecure temporary file creation",
                  "mktemp() creates predictable file paths susceptible to symlink race conditions.",
                  "Use tempfile.NamedTemporaryFile() or tempfile.TemporaryDirectory() in a with-statement.",
                  ["OWASP A01:2021", "CWE-377"]),
    "PICKLE": ("critical", "security", "Unsafe object deserialization",
               "Unpickling untrusted data can trigger arbitrary remote code execution via __reduce__.",
               "Use safer data interchange formats like json or safe signed serializers.",
               ["OWASP A08:2021", "CWE-502"]),
    "RESOURCE": ("medium", "resource", "Resource is never closed",
                 "A file or database connection is opened without a with-block or close() call.",
                 "Wrap it in a with-statement context manager to ensure safe closing on all execution paths.",
                 ["CWE-400", "CWE-775"]),
    "EXCEPT": ("medium", "error-handling", "Exception is masked",
               "A bare except or pass block silently swallows errors, concealing system failures.",
               "Catch the specific exception type and log or re-raise it.",
               ["CWE-391"]),
    "UNDEF": ("high", "logic", "Undefined name",
              "This name is used but never defined, resulting in a runtime NameError crash.",
              "Define the variable or verify the correct spelling before use.", []),
    "ZERODIV": ("medium", "logic", "Possible division by zero",
                "Division by len(...) or an unchecked denominator can crash with ZeroDivisionError.",
                "Guard the operation with 'if denominator:' or provide a safe default.", []),
    "INPUTSTR": ("medium", "logic", "input() returns text",
                 "A string from input() is used in arithmetic or numeric comparison without type conversion.",
                 "Convert the value explicitly: int(input(...)) or float(input(...)).", []),
    "STRCAT": ("high", "logic", "Text and number joined with +",
               "Concatenating a string and a numeric value raises a TypeError in Python.",
               "Use an f-string or convert with str(value).", []),
    "OFFBY1": ("high", "logic", "Loop runs past array bounds",
               "range(len(x) + 1) index reaches len(x), triggering an IndexError.",
               "Use range(len(x)) or iterate over elements directly.", []),
    "MODITER": ("medium", "logic", "Collection modified while iterating",
                "Adding or removing items from a list/dict during iteration skips elements or loops infinitely.",
                "Iterate over a copy (e.g. list(items)) or construct a new filtered collection.", []),
    "NORETVAL": ("high", "logic", "Function returns nothing",
                 "The return value of this function call is used, but the function has no return statement.",
                 "Add an explicit return statement returning the computed value.", []),
    "SELFARG": ("high", "logic", "Method missing self argument",
                "Instance method lacks 'self' as its first parameter.",
                "Add 'self' as the first parameter or use @staticmethod.", []),
    "ATTR": ("high", "logic", "Attribute is never set",
             "This attribute is referenced on self but is never initialized in __init__ or the class.",
             "Initialize the attribute in __init__ or verify attribute name spelling.", []),
    "ISLIT": ("low", "logic", "'is' used to compare literals",
              "'is' checks object identity rather than value equality, leading to erratic comparison results.",
              "Use == or != to compare values.", []),
    "UNREACH": ("low", "logic", "Unreachable code",
                "Code placed after a return, raise, break, or continue will never execute.",
                "Remove unreachable code or reposition it before the jump.", []),
    "ARITH": ("high", "logic", "Price and quantity are added",
              "Adding price and quantity produces an invalid total; price must be multiplied by quantity.",
              "Multiply values: price * quantity.", []),
    "PERCENT": ("high", "logic", "Percentage applied without division by 100",
                "Percentage rate is multiplied directly without dividing by 100, magnifying values 100x.",
                "Divide by 100: total * (rate / 100).", []),
    "NEGVAL": ("medium", "logic", "Negative value passed to sensitive parameter",
               "A negative number was passed for price, quantity, or salary where negatives are invalid.",
               "Validate arguments and reject negative numbers at the function entry.", []),
    "UNUSED": ("low", "maintainability", "Unused import",
               "Imported module or symbol is never referenced in this file.",
               "Remove the unused import to keep dependencies clean.", ["PEP 8"]),
    "MUTDEF": ("low", "logic", "Mutable default argument",
               "Using [] or {} as a default argument creates shared state between all function invocations.",
               "Set default to None and initialize new instances inside the function.", ["PEP 570"]),
    "COMPLEX": ("medium", "maintainability", "High cyclomatic complexity",
                "Function has high cyclomatic complexity, making it prone to defects and hard to test.",
                "Refactor into smaller helper functions with early guard clauses.", ["NIST 500-235"]),
    "WILDCARD": ("low", "maintainability", "Wildcard import used",
                 "'from module import *' obscures origin of symbols and risks name collision.",
                 "Import specific required functions or classes explicitly.", ["PEP 8"]),
    "SECASSERT": ("medium", "security", "assert used for validation/security",
                  "assert statements are stripped out when Python runs with the -O (optimized) flag.",
                  "Use explicit 'if condition: raise ValueError(...)' validation.", ["OWASP A05:2021", "CWE-617"]),
    "INFINITE": ("high", "logic", "Potential infinite loop",
                 "while loop has no break, return, or raise statement, causing execution hangs.",
                 "Ensure an exit condition or break statement exists inside the loop body.", ["CWE-835"]),
    "REDUNDANT_BOOL": ("low", "maintainability", "Redundant boolean comparison",
                       "Comparing explicitly with '== True', '== False', or '== None'.",
                       "Use 'if condition:' or 'if val is None:'.", ["PEP 8"]),
    "SHADOW": ("low", "maintainability", "Shadows Python built-in",
               "Variable name masks a standard Python built-in type or function.",
               "Choose a more descriptive identifier that avoids built-in collision.", []),
    "LONG_FUNC": ("low", "maintainability", "Function is too long (> 45 LOC)",
                 "Long functions are difficult to comprehend, test, and maintain.",
                 "Decompose into smaller single-responsibility sub-functions.", []),
    "DEEP_NEST": ("medium", "maintainability", "Deeply nested control flow (> 3 levels)",
                 "Deep nesting complicates cognitive flow and increases defect probability.",
                 "Use guard clauses and early returns to flatten indentation.", []),
    "TOO_MANY_ARGS": ("low", "maintainability", "Too many function parameters (> 5 args)",
                      "Functions taking more than 5 parameters are difficult to invoke correctly.",
                      "Encapsulate parameters into a dataclass, dictionary, or config object.", []),
}

CHANGE_LABEL = {
    "SQLI": "Parameterized queries", "SHELL": "Safer process execution",
    "SECRET": "Secrets read from environment", "EVAL": "Removed eval/exec",
    "INSECHASH": "Upgraded to SHA-256", "INSECTEMP": "Safe temporary files",
    "PICKLE": "Safe deserialization", "RESOURCE": "Context managers for resources",
    "EXCEPT": "Specific exception handling", "MUTDEF": "Safe default arguments",
    "UNDEF": "Fixed undefined names", "ZERODIV": "Guarded division by zero",
    "INPUTSTR": "Converted input to numbers", "STRCAT": "Fixed string-number concat",
    "OFFBY1": "Fixed off-by-one loop", "MODITER": "Safe collection iteration",
    "NORETVAL": "Added missing return", "SELFARG": "Added self parameter",
    "ATTR": "Fixed attribute names", "ISLIT": "Used == for comparisons",
    "UNREACH": "Removed unreachable code", "NEGVAL": "Validated input values",
    "UNUSED": "Removed unused imports", "ARITH": "Fixed price times quantity",
    "PERCENT": "Fixed percentage math", "COMPLEX": "Complexity reduced",
    "WILDCARD": "Explicit imports", "SECASSERT": "Explicit validation over assert",
    "INFINITE": "Loop exit guard added", "REDUNDANT_BOOL": "Cleaned boolean comparisons",
    "SHADOW": "Renamed shadowed built-ins", "LONG_FUNC": "Function modularized",
    "DEEP_NEST": "Flattened nested structures", "TOO_MANY_ARGS": "Consolidated arguments",
}

COMPLIANCE = [
    ("OWASP A03:2021 Injection", "CWE-89, CWE-78", {"SQLI", "SHELL"}),
    ("OWASP A07:2021 Identification & Auth", "CWE-798", {"SECRET"}),
    ("OWASP A05:2021 Security Misconfiguration", "CWE-95, CWE-617", {"EVAL", "SECASSERT"}),
    ("OWASP A02:2021 Cryptographic Failures", "CWE-327, CWE-328", {"INSECHASH"}),
    ("OWASP A08:2021 Software & Data Integrity", "CWE-502", {"PICKLE"}),
    ("OWASP A01:2021 Broken Access Control / Race", "CWE-377", {"INSECTEMP"}),
    ("Resource Management", "CWE-400, CWE-775", {"RESOURCE"}),
    ("Error Handling", "CWE-391", {"EXCEPT"}),
]

LIKELY = {"ARITH", "PERCENT", "ZERODIV", "INPUTSTR", "MODITER", "NORETVAL", "NEGVAL", "ISLIT", "INFINITE"}
SECRET_RE = re.compile(r"(pass(word|wd)?|secret|api[_-]?key|token|private[_-]?key|auth_token)", re.I)
SECRET_SKIP = re.compile(r"(type|url|path|name|file|field|header|label)$", re.I)
BUILTIN_NAMES = {"list", "dict", "set", "str", "int", "float", "id", "type", "input", "print", "len", "max", "min", "sum", "range", "filter", "map", "format"}


class Finder:
    def __init__(self):
        self.items, self.seen = [], set()

    def add(self, rule, line, title=None, detail=None):
        if (rule, line) in self.seen:
            return
        self.seen.add((rule, line))
        if rule in RULES:
            sev, cat, t, d, fix, std = RULES[rule]
        else:
            sev, cat, t, d, fix, std = "medium", "maintainability", rule, "", "", []
        self.items.append({
            "id": f"ast-{rule}-{line}", "line": line, "severity": sev, "category": cat,
            "title": title or t, "detail": detail or d, "suggestion": fix,
            "source": "ast", "rule": rule, "standards": std,
            "sources": ["static"], "confidence": "likely" if rule in LIKELY else "confirmed",
        })


def call_name(call):
    f, parts = call.func, []
    while isinstance(f, ast.Attribute):
        parts.append(f.attr)
        f = f.value
    if isinstance(f, ast.Name):
        parts.append(f.id)
    return ".".join(reversed(parts))


def unsafe_sql(a):
    if isinstance(a, ast.JoinedStr):
        return any(isinstance(v, ast.FormattedValue) for v in a.values)
    if isinstance(a, ast.BinOp) and isinstance(a.op, (ast.Add, ast.Mod)):
        return not (isinstance(a.left, ast.Constant) and isinstance(a.right, ast.Constant))
    return isinstance(a, ast.Call) and isinstance(a.func, ast.Attribute) and a.func.attr == "format"


def cyclomatic(node):
    n = 1
    for x in ast.walk(node):
        if isinstance(x, (ast.If, ast.For, ast.While, ast.AsyncFor, ast.ExceptHandler, ast.IfExp, ast.Assert)):
            n += 1
        elif isinstance(x, ast.BoolOp):
            n += len(x.values) - 1
        elif isinstance(x, ast.comprehension):
            n += 1 + len(x.ifs)
    return n


def maintainability(code, cc):
    try:
        toks = [t for t in tokenize.generate_tokens(io.StringIO(code).readline)
                if t.type in (tokenize.NAME, tokenize.OP, tokenize.NUMBER, tokenize.STRING)]
    except (tokenize.TokenError, IndentationError):
        return 0
    volume = max(1.0, len(toks) * math.log2(max(len({t.string for t in toks}), 2)))
    loc = count_loc(code)
    mi = (171 - 5.2 * math.log(volume) - 0.23 * cc - 16.2 * math.log(loc)) * 100 / 171
    return int(max(0, min(100, mi)))


def count_loc(code):
    return max(1, sum(1 for l in code.splitlines() if l.strip() and not l.strip().startswith("#")))


def check_resources(tree, finder):
    scopes = [tree] + [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    for scope in scopes:
        closed, opened = set(), []
        for n in ast.walk(scope):
            if (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "close"
                    and isinstance(n.func.value, ast.Name)):
                closed.add(n.func.value.id)
            if (isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and len(n.targets) == 1
                    and isinstance(n.targets[0], ast.Name)):
                name = call_name(n.value)
                if name == "open" or name.endswith(".connect") or name == "socket.socket":
                    opened.append((n.targets[0].id, n.lineno, name))
        for var, line, name in opened:
            if var not in closed:
                finder.add("RESOURCE", line, detail=f"'{var}' from {name}() is opened but never closed.")


BLOCK_RE = re.compile(r"^\s*(async\s+)?(def|class|if|elif|else|for|while|try|except|finally|with)\b")


def syntax_issue(line, msg):
    return {"id": f"ast-SYNTAX-{line}", "line": line, "severity": "critical", "category": "syntax",
            "title": "Syntax error", "detail": msg, "suggestion": "Fix the syntax error, then review again.",
            "source": "ast", "rule": "SYNTAX", "standards": [],
            "sources": ["static"], "confidence": "confirmed"}


def repair_colons(code):
    lines, missing, depth = code.splitlines(), [], 0
    for n, line in enumerate(lines, 1):
        part = line.split("#")[0].rstrip()
        tmp = re.sub(r"(['\"]).*?\1", "", part.strip())
        while True:
            new = re.sub(r"\([^()]*\)|\[[^\[\]]*\]|\{[^{}]*\}", "", tmp)
            if new == tmp:
                break
            tmp = new
        if depth == 0 and BLOCK_RE.match(part) and ":" not in tmp and not part.endswith(("\\", ",")):
            missing.append(n)
            lines[n - 1] = line[: len(part)] + ":" + line[len(part):]
        depth = max(0, depth + sum(part.count(c) for c in "([{") - sum(part.count(c) for c in ")]}"))
    return "\n".join(lines), missing


def find_undefined(tree, f):
    defined = set(dir(builtins)) | {"__file__", "__name__", "__doc__"}
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defined.add(n.name)
        elif isinstance(n, ast.arg):
            defined.add(n.arg)
        elif isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
            defined.add(n.id)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names:
                if a.name == "*":
                    return
                defined.add((a.asname or a.name).split(".")[0])
        elif isinstance(n, ast.ExceptHandler) and n.name:
            defined.add(n.name)
        elif isinstance(n, (ast.Global, ast.Nonlocal)):
            defined.update(n.names)
    for n in ast.walk(tree):
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id not in defined:
            f.add("UNDEF", n.lineno, title=f"Undefined name '{n.id}'",
                  detail=f"'{n.id}' is referenced but never defined. Check for missing imports or typos.")


NUMCALLS = {"len", "int", "float", "sum", "round", "abs"}


def is_num(n):
    if isinstance(n, ast.Call):
        return call_name(n) in NUMCALLS
    if isinstance(n, ast.BinOp):
        return isinstance(n.op, (ast.Div, ast.Sub, ast.FloorDiv))
    return isinstance(n, ast.Constant) and isinstance(n.value, (int, float)) and not isinstance(n.value, bool)


def callee(c):
    fn = c.func
    if isinstance(fn, ast.Name):
        return fn.id
    if isinstance(fn, ast.Attribute) and isinstance(fn.value, ast.Name) and fn.value.id in ("self", "cls"):
        return fn.attr
    return None


PRICE_RE = re.compile(r"(price|cost)", re.I)
QTY_RE = re.compile(r"(quantity|qty|units)", re.I)
PCT_RE = re.compile(r"(discount|percent|pct|tax|interest|gst|vat)", re.I)


def key_of(n):
    if isinstance(n, ast.Name):
        return n.id
    if isinstance(n, ast.Attribute):
        return n.attr
    if isinstance(n, ast.Subscript) and isinstance(n.slice, ast.Constant) and isinstance(n.slice.value, str):
        return n.slice.value
    return ""


def check_nesting_depth(node):
    max_d = 0
    def walk_depth(n, d):
        nonlocal max_d
        if isinstance(n, (ast.If, ast.For, ast.While, ast.AsyncFor, ast.Try)):
            d += 1
            if d > max_d:
                max_d = d
        for child in ast.iter_child_nodes(n):
            walk_depth(child, d)
    walk_depth(node, 0)
    return max_d


def check_code_smells(tree, f):
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            start = n.lineno
            end = n.end_lineno or start
            loc = end - start + 1
            if loc > 45:
                f.add("LONG_FUNC", n.lineno, detail=f"Function '{n.name}' is {loc} lines long. Consider splitting.")

            num_args = len(n.args.args)
            if n.args.vararg: num_args += 1
            if n.args.kwarg: num_args += 1
            if num_args > 5:
                f.add("TOO_MANY_ARGS", n.lineno, detail=f"Function '{n.name}' has {num_args} parameters. Consider a data object.")

            depth = check_nesting_depth(n)
            if depth > 3:
                f.add("DEEP_NEST", n.lineno, detail=f"Function '{n.name}' has nesting depth of {depth}. Flatten with guard clauses.")


def check_logic(tree, f):
    parents = {c: p for p in ast.walk(tree) for c in ast.iter_child_nodes(p)}
    FUNCS = (ast.FunctionDef, ast.AsyncFunctionDef)
    noret, assigns, other = set(), {}, set()
    for n in ast.walk(tree):
        if isinstance(n, FUNCS):
            has_val = any((isinstance(x, ast.Return) and x.value is not None) or isinstance(x, (ast.Yield, ast.YieldFrom))
                          for x in ast.walk(n))
            trivial = len(n.body) == 1 and isinstance(n.body[0], (ast.Pass, ast.Raise, ast.Expr))
            if not has_val and not trivial and not n.name.startswith("__") and not n.decorator_list:
                noret.add(n.name)
            other.update(a.arg for a in n.args.args + n.args.kwonlyargs)
        elif isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
            assigns.setdefault(n.targets[0].id, []).append(n.value)
        elif isinstance(n, (ast.For, ast.comprehension)):
            other.update(x.id for x in ast.walk(n.target) if isinstance(x, ast.Name))
        elif isinstance(n, ast.With):
            for it in n.items:
                if it.optional_vars is not None:
                    other.update(x.id for x in ast.walk(it.optional_vars) if isinstance(x, ast.Name))
    numeric = {k for k, v in assigns.items() if k not in other and all(is_num(x) for x in v)
               and any(not isinstance(x, ast.Constant) for x in v)}
    inputs = {k for k, v in assigns.items() if k not in other
              and all(isinstance(x, ast.Call) and call_name(x) == "input" for x in v)}

    pct = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Assign) and isinstance(n.value, ast.Constant) and isinstance(n.value.value, (int, float)) \
                and not isinstance(n.value.value, bool) and 1 < n.value.value <= 100:
            pct.update(k for k in (key_of(t) for t in n.targets) if k and PCT_RE.search(k))
        elif isinstance(n, FUNCS):
            pos = n.args.args
            for a, d in zip(pos[len(pos) - len(n.args.defaults):], n.args.defaults):
                if isinstance(d, ast.Constant) and isinstance(d.value, (int, float)) and not isinstance(d.value, bool) \
                        and 1 < d.value <= 100 and PCT_RE.search(a.arg):
                    pct.add(a.arg)

    def scope_of(n):
        while n in parents and not isinstance(n, FUNCS):
            n = parents[n]
        return n

    for n in ast.walk(tree):
        if isinstance(n, ast.BinOp):
            if isinstance(n.op, ast.Add):
                lk, rk = key_of(n.left), key_of(n.right)
                if (PRICE_RE.search(lk) and QTY_RE.search(rk)) or (QTY_RE.search(lk) and PRICE_RE.search(rk)):
                    f.add("ARITH", n.lineno, detail=f"'{lk}' and '{rk}' are added; a line total should be {lk} * {rk}.")
            if isinstance(n.op, ast.Mult):
                for side in (n.left, n.right):
                    k = key_of(side)
                    if k in pct:
                        st = n
                        while st in parents and not isinstance(st, ast.stmt):
                            st = parents[st]
                        if "100" not in ast.unparse(st):
                            f.add("PERCENT", n.lineno,
                                  detail=f"'{k}' is a percentage (set above 1) but is multiplied without dividing by 100.")
            for a, b in ((n.left, n.right), (n.right, n.left)):
                if isinstance(a, ast.Constant) and isinstance(a.value, str) and (
                        (isinstance(b, ast.Call) and call_name(b) in NUMCALLS) or (isinstance(b, ast.Name) and b.id in numeric)):
                    f.add("STRCAT", n.lineno)
            if isinstance(n.op, (ast.Div, ast.FloorDiv, ast.Mod)) and isinstance(n.right, ast.Call) \
                    and call_name(n.right) == "len" and n.right.args:
                arg, sc = ast.unparse(n.right.args[0]), scope_of(n)
                guarded = any(isinstance(t, ast.Try) or (isinstance(t, (ast.If, ast.IfExp, ast.While, ast.Assert))
                              and arg in ast.unparse(t.test)) for t in ast.walk(sc))
                if not guarded:
                    f.add("ZERODIV", n.lineno)
            if isinstance(n.op, (ast.Sub, ast.Div, ast.Add)):
                for a, b in ((n.left, n.right), (n.right, n.left)):
                    if isinstance(a, ast.Name) and a.id in inputs and isinstance(b, ast.Constant) \
                            and isinstance(b.value, (int, float)) and not isinstance(b.value, bool):
                        f.add("INPUTSTR", n.lineno)
        elif isinstance(n, ast.Compare):
            sides = [n.left] + n.comparators
            if any(isinstance(o, (ast.Lt, ast.Gt, ast.LtE, ast.GtE)) for o in n.ops) and \
                    any(isinstance(x, ast.Name) and x.id in inputs for x in sides) and \
                    any(isinstance(x, ast.Constant) and isinstance(x.value, (int, float)) for x in sides):
                f.add("INPUTSTR", n.lineno)
            for o, c in zip(n.ops, n.comparators):
                if isinstance(o, (ast.Is, ast.IsNot)) and isinstance(c, ast.Constant) \
                        and isinstance(c.value, (str, bytes, int, float)) and not isinstance(c.value, bool):
                    f.add("ISLIT", n.lineno)
                if isinstance(c, ast.Constant):
                    if c.value is True or c.value is False:
                        f.add("REDUNDANT_BOOL", n.lineno, detail=f"Comparison with '{c.value}' is redundant. Use truthiness check directly.")
                    elif c.value is None and isinstance(o, (ast.Eq, ast.NotEq)):
                        f.add("REDUNDANT_BOOL", n.lineno, detail="Comparing with None using == or !=. Use 'is None' or 'is not None'.")
        elif isinstance(n, ast.For):
            if isinstance(n.iter, ast.Call) and call_name(n.iter) == "range" and isinstance(n.target, ast.Name):
                for a in n.iter.args:
                    if isinstance(a, ast.BinOp) and isinstance(a.op, ast.Add) and isinstance(a.left, ast.Call) \
                            and call_name(a.left) == "len" and a.left.args and isinstance(a.right, ast.Constant) \
                            and a.right.value == 1:
                        seq = ast.unparse(a.left.args[0])
                        if any(isinstance(x, ast.Subscript) and ast.unparse(x.value) == seq and isinstance(x.slice, ast.Name)
                                and x.slice.id == n.target.id for x in ast.walk(n)):
                            f.add("OFFBY1", n.lineno)
            if isinstance(n.iter, (ast.Name, ast.Attribute)):
                seq = ast.unparse(n.iter)
                for x in ast.walk(n):
                    if isinstance(x, ast.Call) and isinstance(x.func, ast.Attribute) and x.func.attr in (
                            "remove", "append", "pop", "insert", "extend", "clear") and ast.unparse(x.func.value) == seq:
                        f.add("MODITER", x.lineno)
        elif isinstance(n, ast.While):
            if isinstance(n.test, ast.Constant) and n.test.value is True:
                has_break = any(isinstance(x, (ast.Break, ast.Return, ast.Raise)) for x in ast.walk(n))
                if not has_break:
                    f.add("INFINITE", n.lineno)
        elif isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and callee(n.value) in noret:
            f.add("NORETVAL", n.lineno, detail=f"'{callee(n.value)}' never returns a value, so '{ast.unparse(n.targets[0])}' is always None.")
        elif isinstance(n, ast.Call) and call_name(n) in ("print", "len", "str", "float", "int", "sum"):
            for a in n.args:
                if isinstance(a, ast.Call) and callee(a) in noret:
                    f.add("NORETVAL", a.lineno, detail=f"'{callee(a)}' never returns a value, so this prints or operates on None.")
        elif isinstance(n, ast.ClassDef):
            for m in n.body:
                if isinstance(m, FUNCS) and not m.decorator_list and not m.args.posonlyargs \
                        and m.name not in ("__new__", "__init_subclass__", "__class_getitem__") \
                        and (not m.args.args or m.args.args[0].arg not in ("self", "cls")):
                    f.add("SELFARG", m.lineno, detail=f"Method '{m.name}' has no self parameter, so instance calls will fail.")
            if not n.decorator_list and all(isinstance(b, ast.Name) and b.id == "object" for b in n.bases):
                known = set()
                for m in n.body:
                    if isinstance(m, FUNCS):
                        known.add(m.name)
                    elif isinstance(m, ast.Assign):
                        known.update(t.id for t in m.targets if isinstance(t, ast.Name))
                    elif isinstance(m, ast.AnnAssign) and isinstance(m.target, ast.Name):
                        known.add(m.target.id)
                for x in ast.walk(n):
                    if isinstance(x, ast.Attribute) and isinstance(x.ctx, (ast.Store, ast.Del)) \
                            and isinstance(x.value, ast.Name) and x.value.id in ("self", "cls"):
                        known.add(x.attr)
                dynamic = {"__getattr__", "__slots__", "__getattribute__"} & known or any(
                    isinstance(x, ast.Call) and call_name(x) in ("setattr", "getattr", "vars") for x in ast.walk(n))
                if not dynamic:
                    for x in ast.walk(n):
                        if isinstance(x, ast.Attribute) and isinstance(x.ctx, ast.Load) and isinstance(x.value, ast.Name) \
                                and x.value.id == "self" and x.attr not in known and not x.attr.startswith("__"):
                            f.add("ATTR", x.lineno, title=f"'self.{x.attr}' is never set",
                                  detail=f"'self.{x.attr}' is read but never assigned in this class.")
        for field in ("body", "orelse", "finalbody"):
            block = getattr(n, field, None)
            if isinstance(block, list):
                for a, b in zip(block, block[1:]):
                    if isinstance(a, (ast.Return, ast.Raise, ast.Break, ast.Continue)) and isinstance(b, ast.stmt):
                        f.add("UNREACH", b.lineno)


def find_unused_imports(tree, f):
    used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
    for n in ast.walk(tree):
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            if isinstance(n, ast.ImportFrom) and n.module == "__future__":
                continue
            names = [(a.asname or a.name).split(".")[0] for a in n.names if a.name != "*"]
            dead = [x for x in names if x not in used]
            if dead:
                f.add("UNUSED", n.lineno, title="Unused import " + ", ".join(f"'{x}'" for x in dead),
                      detail=f"{', '.join(dead)} is imported but never referenced.")


NEG_RE = re.compile(r"(salary|hours|price|quantity|qty|age|amount|marks|score|weight)", re.I)


def check_negative_args(tree, f):
    FUNCS = (ast.FunctionDef, ast.AsyncFunctionDef)
    defs = {}
    for n in ast.walk(tree):
        if isinstance(n, ast.ClassDef):
            for m in n.body:
                if isinstance(m, FUNCS) and m.name == "__init__":
                    defs.setdefault(n.name, m)
        elif isinstance(n, FUNCS):
            defs.setdefault(n.name, n)

    def neg(a):
        return (isinstance(a, ast.UnaryOp) and isinstance(a.op, ast.USub) and isinstance(a.operand, ast.Constant)
                and isinstance(a.operand.value, (int, float)) and a.operand.value > 0)

    def validated(fn, pname):
        return any(isinstance(c, ast.Compare) and any(isinstance(x, ast.Name) and x.id == pname for x in [c.left] + c.comparators)
                   and any(isinstance(x, ast.Constant) and isinstance(x.value, (int, float)) for x in [c.left] + c.comparators)
                   for c in ast.walk(fn))

    for call in ast.walk(tree):
        if not isinstance(call, ast.Call):
            continue
        name = call.func.id if isinstance(call.func, ast.Name) else call.func.attr if isinstance(call.func, ast.Attribute) else ""
        fn = defs.get(name)
        if not fn:
            continue
        plist = [a.arg for a in fn.args.args if a.arg not in ("self", "cls")]
        pairs = [(plist[i], a) for i, a in enumerate(call.args) if i < len(plist)] + [(k.arg, k.value) for k in call.keywords if k.arg]
        for pname, val in pairs:
            if neg(val) and NEG_RE.search(pname) and not validated(fn, pname):
                f.add("NEGVAL", call.lineno, detail=f"-{val.operand.value} passed for '{pname}', and '{fn.name}' does not validate against negative values.")


def analyze_python(code):
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        fixed, missing = repair_colons(code)
        found = [syntax_issue(n, "Missing ':' at the end of this line.") for n in missing]
        if missing:
            try:
                ast.parse(fixed)
            except SyntaxError as e2:
                found.append(syntax_issue(e2.lineno or 1, e2.msg))
                return {"issues": sort_issues(found), "metrics": None, "valid": False}
            inner = analyze_python(fixed)
            return {"issues": sort_issues(found + inner["issues"]), "metrics": inner["metrics"], "valid": False}
        return {"issues": [syntax_issue(e.lineno or 1, e.msg)], "metrics": None, "valid": False}

    f = Finder()
    funcs = [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]

    for n in ast.walk(tree):
        if isinstance(n, ast.Call):
            name = call_name(n)
            if name in ("eval", "exec"):
                f.add("EVAL", n.lineno, detail=f"{name}() executes arbitrary text as executable code.")
            if name in ("hashlib.md5", "hashlib.sha1"):
                f.add("INSECHASH", n.lineno, detail=f"{name}() is vulnerable to collision attacks; use hashlib.sha256().")
            if name in ("tempfile.mktemp", "mktemp"):
                f.add("INSECTEMP", n.lineno, detail="mktemp() creates predictable paths susceptible to symlink race conditions.")
            if name in ("pickle.loads", "pickle.load", "_pickle.loads", "_pickle.load"):
                f.add("PICKLE", n.lineno, detail="pickle deserialization allows arbitrary code execution via __reduce__.")
            if name == "os.system" or any(
                k.arg == "shell" and isinstance(k.value, ast.Constant) and k.value.value is True for k in n.keywords
            ):
                f.add("SHELL", n.lineno)
            if name.split(".")[-1] in ("execute", "executemany", "executescript") and n.args and unsafe_sql(n.args[0]):
                f.add("SQLI", n.lineno)
        elif isinstance(n, (ast.Assign, ast.AnnAssign)):
            targets = n.targets if isinstance(n, ast.Assign) else [n.target]
            v = n.value
            for t in targets:
                nm = t.id if isinstance(t, ast.Name) else t.attr if isinstance(t, ast.Attribute) else ""
                if nm in BUILTIN_NAMES:
                    f.add("SHADOW", n.lineno, detail=f"Variable name '{nm}' shadows Python built-in.")
                if isinstance(v, ast.Constant) and isinstance(v.value, str) and len(v.value) >= 4:
                    if nm and SECRET_RE.search(nm) and not SECRET_SKIP.search(nm):
                        f.add("SECRET", n.lineno, detail=f"'{nm}' is set to a literal credential string.")
        elif isinstance(n, ast.ImportFrom):
            if any(a.name == "*" for a in n.names):
                f.add("WILDCARD", n.lineno, detail=f"Wildcard import 'from {n.module or '...'} import *' pollutes namespace.")
        elif isinstance(n, ast.Assert):
            f.add("SECASSERT", n.lineno, detail="assert statements are omitted when Python runs with -O flag; use explicit conditional raises.")
        elif isinstance(n, ast.ExceptHandler):
            if n.type is None:
                f.add("EXCEPT", n.lineno, title="Bare except clause")
            elif all(isinstance(b, (ast.Pass, ast.Continue)) for b in n.body):
                f.add("EXCEPT", n.lineno, title="Exception silenced")
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for d in n.args.defaults + [x for x in n.args.kw_defaults if x]:
                if isinstance(d, (ast.List, ast.Dict, ast.Set)):
                    f.add("MUTDEF", d.lineno)

    check_resources(tree, f)
    find_undefined(tree, f)
    check_logic(tree, f)
    check_negative_args(tree, f)
    find_unused_imports(tree, f)
    check_code_smells(tree, f)

    ccs = []
    for fn in funcs:
        c = cyclomatic(fn)
        ccs.append(c)
        if c > 10:
            f.add("COMPLEX", fn.lineno, title=f"'{fn.name}' is too complex",
                  detail=f"Cyclomatic complexity is {c}; above 10 is difficult to test and maintain.")
    top = max(ccs) if ccs else cyclomatic(tree)
    metrics = {
        "complexity": top,
        "maintainability": maintainability(code, top),
        "loc": count_loc(code),
        "functions": len(funcs),
    }
    return {"issues": sort_issues(f.items), "metrics": metrics, "valid": True}


# ───────────────────────── static analysis (JavaScript / TypeScript) ─────────────────────────

JS_RULES = {
    "EVAL_JS": ("critical", "security", "Dynamic code evaluation",
                "eval() or Function() constructor executes arbitrary strings as JavaScript.",
                "Use JSON.parse() or structured logic instead of eval().", ["OWASP A05:2021", "CWE-95"]),
    "XSS_JS": ("high", "security", "DOM Cross-Site Scripting (XSS)",
               "Directly assigning untrusted HTML to innerHTML/outerHTML executes attacker scripts.",
               "Use textContent, or sanitize HTML with DOMPurify.", ["OWASP A03:2021", "CWE-79"]),
    "SHELL_JS": ("high", "security", "Shell command injection in child_process",
                 "child_process.exec() runs commands in a system shell with concatenated strings.",
                 "Use child_process.execFile() or spawn() with argument arrays.", ["OWASP A03:2021", "CWE-78"]),
    "EQEQ_JS": ("low", "logic", "Loose equality (==)",
                "Loose equality performs unexpected type coercion in JavaScript.",
                "Use strict equality (=== and !==).", []),
    "SECRET_JS": ("high", "security", "Hardcoded credential or API key",
                  "API key, secret token, or credential hardcoded in JavaScript source.",
                  "Read credentials from process.env or secret manager.", ["OWASP A07:2021", "CWE-798"]),
}


def analyze_javascript(code):
    items = []
    lines = code.splitlines()
    for idx, line in enumerate(lines, 1):
        clean = line.split("//")[0].strip()
        if not clean:
            continue
        if re.search(r"\beval\s*\(|\bnew\s+Function\s*\(", clean):
            items.append({"id": f"js-EVAL-{idx}", "line": idx, "severity": "critical", "category": "security",
                          "title": "Dynamic code evaluation", "detail": "eval() executes arbitrary JavaScript strings.",
                          "suggestion": "Use JSON.parse() or map lookups.", "source": "static", "rule": "EVAL_JS",
                          "standards": ["OWASP A05:2021", "CWE-95"], "sources": ["static"], "confidence": "confirmed"})
        if re.search(r"\.(innerHTML|outerHTML)\s*=|document\.write\s*\(", clean):
            items.append({"id": f"js-XSS-{idx}", "line": idx, "severity": "high", "category": "security",
                          "title": "DOM Cross-Site Scripting (XSS)", "detail": "Directly assigning markup to innerHTML can execute arbitrary scripts.",
                          "suggestion": "Use element.textContent or DOMPurify.sanitize().", "source": "static", "rule": "XSS_JS",
                          "standards": ["OWASP A03:2021", "CWE-79"], "sources": ["static"], "confidence": "confirmed"})
        if re.search(r"child_process\.exec\s*\(|\bexec\s*\([^,)]*\+", clean):
            items.append({"id": f"js-SHELL-{idx}", "line": idx, "severity": "high", "category": "security",
                          "title": "Shell command injection", "detail": "Running commands in a shell with concatenated strings risks remote execution.",
                          "suggestion": "Use child_process.execFile() with an argument array.", "source": "static", "rule": "SHELL_JS",
                          "standards": ["OWASP A03:2021", "CWE-78"], "sources": ["static"], "confidence": "confirmed"})
        if re.search(r"(?:const|let|var)\s+\w*(?:key|secret|token|password)\w*\s*=\s*['\"][A-Za-z0-9_\-]{8,}['\"]", clean, re.I):
            items.append({"id": f"js-SECRET-{idx}", "line": idx, "severity": "high", "category": "security",
                          "title": "Hardcoded secret or credential", "detail": "A credential or token is written into the JavaScript source.",
                          "suggestion": "Read it from process.env.", "source": "static", "rule": "SECRET_JS",
                          "standards": ["OWASP A07:2021", "CWE-798"], "sources": ["static"], "confidence": "confirmed"})
        if re.search(r"[^!=]==(?!=)|!=(?!=)", clean):
            items.append({"id": f"js-EQEQ-{idx}", "line": idx, "severity": "low", "category": "logic",
                          "title": "Loose equality used", "detail": "== and != allow type coercion bugs in JavaScript.",
                          "suggestion": "Use strict equality (=== and !==).", "source": "static", "rule": "EQEQ_JS",
                          "standards": [], "sources": ["static"], "confidence": "confirmed"})

    loc = count_loc(code)
    metrics = {"complexity": 1 + len(items), "maintainability": max(10, 100 - len(items) * 12), "loc": loc, "functions": None}
    return {"issues": sort_issues(items), "metrics": metrics, "valid": True}


def sort_issues(items):
    return sorted(items, key=lambda i: (SEVERITIES.index(i["severity"]), i["line"]))


def penalty(i):
    return SEV_WEIGHT[i["severity"]] * (0.5 if i.get("confidence") == "opinion" else 1)


def score_of(issues):
    return max(0, round(100 - sum(penalty(i) for i in issues)))


GROUPS = [("Syntax", {"syntax"}), ("Security", {"security"}), ("Logic", {"logic"}),
          ("Reliability", {"resource", "error-handling"}), ("Maintainability", {"maintainability", "style", "performance"})]


def breakdown(issues):
    return [{"name": n, "score": max(0, round(100 - sum(penalty(i) for i in issues if i["category"] in cats)))}
            for n, cats in GROUPS]


def norm_title(t):
    return re.sub(r"\(.*?\)|[^a-z0-9 ]", "", t.lower()).strip()


def similar(a, b):
    if abs(a["line"] - b["line"]) > 3:
        return False
    r = difflib.SequenceMatcher(None, norm_title(a["title"]), norm_title(b["title"])).ratio()
    same_line = a["line"] == b["line"]
    return r >= 0.75 or (same_line and (a["category"] == b["category"] or r >= 0.5))


def merge_issues(static, ai):
    out = [dict(i, sources=list(i.get("sources", ["static"]))) for i in static]
    for a in ai:
        for o in out:
            if similar(o, a):
                if "model" not in o["sources"]:
                    o["sources"].append("model")
                if o["source"] == "ai":
                    if SEVERITIES.index(a["severity"]) < SEVERITIES.index(o["severity"]):
                        o["severity"] = a["severity"]
                    if len(a["detail"]) > len(o["detail"]):
                        o["detail"] = a["detail"]
                break
        else:
            out.append(a)
    return sort_issues(out)


SYNTAX_CLAIM = re.compile(r"(colon|syntax|indentation|unexpected indent|parenthes|missing bracket)", re.I)


def squash(t):
    return t.lower().replace(" ", "")


def tokens_of(text):
    quoted = [t for g in re.findall(r"`([^`\n]{2,50})`|'([^'\n]{2,50})'", text) for t in g if t]
    return quoted + [m + "(" for m in re.findall(r"\b([A-Za-z_]\w*)\(\)", text)]


def contradicted(it, lines):
    text, code = f"{it['title']} {it['detail']}", "\n".join(lines)
    bases = {re.sub(r"\W+", "", t.rstrip("(").split(".")[-1]) for t in tokens_of(text)} - {""}
    never = r"\b(never|not|isn't|is not|doesn't|does not|fails? to|no)\b[^.]{0,30}"
    try:
        tree = ast.parse(code)
    except SyntaxError:
        tree = None
    for base in bases:
        if re.search(never + r"(updat|set\b|assign|modif|chang|increment|decrement|deduct|subtract|add(ed)?\b|credit|debit)", text, re.I) and \
                re.search(rf"\b{re.escape(base)}\b\s*([+\-*/]?=)(?!=)", code):
            return True
        if tree and re.search(never + r"return", text, re.I) and any(
                isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) and fn.name == base and any(
                    isinstance(r, ast.Return) and r.value is not None for r in ast.walk(fn)) for fn in ast.walk(tree)):
            return True
        if re.search(never + r"(used|call)", text, re.I) and len(re.findall(rf"\b{re.escape(base)}\b", code)) >= 3:
            return True
    return False


def calibrate(it):
    if it["category"] == "security":
        return it
    text = f"{it['title']} {it['detail']}".lower()
    if it.get("severity") == "critical" and not re.search(r"crash|exception|data loss|infinite|corrupt", text):
        it["severity"] = "high"
    if it.get("severity") == "high" and not it.get("evidence"):
        it["severity"] = "medium"
    return it


VALID_CLAIM = re.compile(r"(validat|invalid input|input handling|missing check|no check|not check|type check|"
                         r"handle (invalid|negative|bad)|negative (value|input|quantity|price)|sanitiz)", re.I)
ZERO_CLAIM = re.compile(r"(division by zero|divide by zero|zerodivision|divided by zero)", re.I)
CLOSE_CLAIM = re.compile(r"(never closed|not closed|unclosed|resource leak|not properly closed|isn't closed)", re.I)


def plausible(it, lines):
    code = "\n".join(lines)
    try:
        tree = ast.parse(code)
    except SyntaxError:
        try:
            tree = ast.parse(repair_colons(code)[0])
        except SyntaxError:
            return True
    text, line = f"{it['title']} {it['detail']}", it["line"]
    FUNCS = (ast.FunctionDef, ast.AsyncFunctionDef)
    fns = [n for n in ast.walk(tree) if isinstance(n, FUNCS) and n.lineno <= line <= (n.end_lineno or n.lineno)]
    fn = max(fns, key=lambda n: n.lineno) if fns else None
    if fn and VALID_CLAIM.search(text):
        params = {a.arg for a in fn.args.args} - {"self", "cls"}
        guarded = set()
        for n in ast.walk(fn):
            if isinstance(n, ast.If) and any(isinstance(x, (ast.Return, ast.Raise)) for b in n.body for x in ast.walk(b)):
                guarded |= {x.id for x in ast.walk(n.test) if isinstance(x, ast.Name) and x.id in params}
        mentioned = {p for p in params if re.search(rf"\b{re.escape(p)}\b", text)}
        if (mentioned & guarded) if mentioned else guarded:
            return False
    if ZERO_CLAIM.search(text):
        scope = fn or tree
        divs = [n for n in ast.walk(scope) if isinstance(n, ast.BinOp) and isinstance(n.op, (ast.Div, ast.FloorDiv, ast.Mod))]
        tests = " ".join(ast.unparse(t.test) for t in ast.walk(scope) if isinstance(t, (ast.If, ast.IfExp, ast.While, ast.Assert)))
        caught = any(isinstance(t, ast.Try) for t in ast.walk(scope))
        if not divs or caught or all(
                (isinstance(d.right, ast.Constant) and d.right.value not in (0, 0.0))
                or any(re.search(rf"\b{re.escape(x.id)}\b", tests) for x in ast.walk(d.right) if isinstance(x, ast.Name))
                for d in divs):
            return False
    if CLOSE_CLAIM.search(text) and any(
            isinstance(w, (ast.With, ast.AsyncWith)) and w.lineno <= line <= (w.end_lineno or w.lineno) for w in ast.walk(tree)):
        return False
    return True


def anchor(it, lines, lang):
    if lang == "python" and SYNTAX_CLAIM.search(it["title"]):
        return None
    n = len(lines)
    norm = [squash(l) for l in lines]
    claimed = it["line"]
    cur = norm[claimed - 1] if 1 <= claimed <= n else ""
    near = lambda hs: min(hs, key=lambda k: abs(k - claimed))
    ev = squash(it.get("evidence") or "").strip("`")
    grounded = False
    if len(ev) >= 4:
        if ev in "".join(norm):
            hs = [k for k, l in enumerate(norm, 1) if ev in l]
            if hs:
                it["line"] = claimed if claimed in hs else near(hs)
            grounded = True
        else:
            return None
    if not grounded:
        title_toks, detail_toks = tokens_of(it["title"]), tokens_of(it["detail"])
        hit = lambda toks: [k for k, l in enumerate(norm, 1) if any(squash(t) in l for t in toks)]
        if title_toks:
            hs = hit(title_toks)
            if not hs:
                return None
            if not any(squash(t) in cur for t in title_toks):
                it["line"] = near(hs)
        else:
            hs = hit(detail_toks) if detail_toks else []
            if hs and not any(squash(t) in cur for t in detail_toks):
                it["line"] = near(hs)
            elif not hs and (not (1 <= claimed <= n) or not lines[claimed - 1].strip()
                             or lines[claimed - 1].strip().startswith("#")):
                return None
    if contradicted(it, lines) or not plausible(it, lines):
        return None
    return calibrate(it)


def compliance_of(issues):
    rules = Counter(i.get("rule") for i in issues)
    rows = [{"name": n, "cwe": c, "status": "violation" if any(rules[r] for r in rs) else "pass",
             "count": sum(rules[r] for r in rs)} for n, c, rs in COMPLIANCE]
    return {"rows": rows, "percent": round(100 * sum(r["status"] == "pass" for r in rows) / len(rows))}


def guess_language(code):
    checks = [
        ("cpp", r"#include\s*<|std::|cout\s*<<"),
        ("java", r"public\s+(static\s+)?(class|void)|System\.out\."),
        ("go", r"^package\s+\w+|^func\s+\w+\(|fmt\.Print"),
        ("typescript", r":\s*(string|number|boolean)\b|^interface\s+\w+"),
        ("javascript", r"\bconsole\.log|\bfunction\s+\w*\(|=>|\b(const|let|var)\s+\w+\s*="),
    ]
    for lang, pat in checks:
        if re.search(pat, code, re.M):
            return lang
    return None


def validate_code(code, lang):
    if lang != "python":
        return None
    try:
        ast.parse(code)
    except SyntaxError as e:
        return f"line {e.lineno}: {e.msg}"
    return None


def diff_rows(a, b):
    A, B, rows = a.splitlines(), b.splitlines(), []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, A, B).get_opcodes():
        for k in range(max(i2 - i1, j2 - j1)):
            l = A[i1 + k] if i1 + k < i2 else None
            r = B[j1 + k] if j1 + k < j2 else None
            rows.append({"t": "same" if tag == "equal" else "del" if r is None else "add" if l is None else "chg",
                         "l": l, "r": r, "ln": i1 + k + 1 if l is not None else None,
                         "rn": j1 + k + 1 if r is not None else None})
    return rows


def summarize(analysis):
    m = analysis["metrics"] or {}
    return {"complexity": m.get("complexity"), "maintainability": m.get("maintainability"),
            "issues": len(analysis["issues"]),
            "security": sum(1 for i in analysis["issues"] if i["category"] == "security")}


# ───────────────────────── API ─────────────────────────

app = FastAPI(title="CodeMind", description="AI Code Reviewer & Security Auditing Platform")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
init_db()


class SettingsIn(BaseModel):
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    review_model: str | None = None
    refactor_model: str | None = None
    timeout: int | None = None


class ReviewIn(BaseModel):
    code: str
    language: str = "python"
    model: str | None = None
    mode: str = "deep"


class RefactorIn(ReviewIn):
    session_id: int | None = None
    issues: list[dict] = []


class FixIn(ReviewIn):
    issue: dict


class CodeActionIn(BaseModel):
    code: str
    language: str = "python"
    model: str | None = None


class RunIn(BaseModel):
    code: str
    language: str = "python"
    stdin: str = ""


class RunTestsIn(BaseModel):
    code: str
    test_code: str
    language: str = "python"


class ChatIn(BaseModel):
    code: str
    language: str = "python"
    prompt: str
    model: str | None = None
    issues: list[dict] = []
    conversation: list[dict] = []


class ProjectScanIn(BaseModel):
    files: list[dict]
    mode: str = "quick"


class CommitIn(BaseModel):
    before_code: str
    after_code: str
    language: str = "python"


@app.get("/api/settings")
def read_settings():
    return get_settings()


@app.put("/api/settings")
def write_settings(b: SettingsIn):
    patch = b.model_dump()
    if patch.get("base_url"):
        patch["base_url"] = patch["base_url"].strip().rstrip("/")
    save_settings(patch)
    return get_settings()


@app.get("/api/models")
async def models():
    s = get_settings()
    try:
        found = await fetch_models(s["base_url"], s.get("api_key", ""))
    except Exception as e:
        return {"online": False, "base_url": s["base_url"], "models": [], "error": str(e) or e.__class__.__name__}
    if found and not s["model"]:
        save_settings({"model": found[0]})
    return {"online": True, "base_url": s["base_url"], "models": found, "error": ""}


@app.get("/api/models/test")
async def test_connection():
    s = get_settings()
    t0 = time.perf_counter()
    try:
        models_list = await fetch_models(s["base_url"], s.get("api_key", ""))
        latency_ms = round((time.perf_counter() - t0) * 1000)
        return {
            "success": True,
            "latency_ms": latency_ms,
            "models_count": len(models_list),
            "base_url": s["base_url"],
            "models": models_list[:10],
        }
    except Exception as e:
        return {
            "success": False,
            "latency_ms": None,
            "models_count": 0,
            "base_url": s["base_url"],
            "error": str(e),
        }


@app.post("/api/review")
async def review(b: ReviewIn):
    if not b.code.strip():
        raise HTTPException(400, "Paste some code to review.")
    lang, s = b.language.lower(), get_settings()
    switched = None
    if lang == "python" and not analyze_python(b.code)["valid"]:
        guess = guess_language(b.code)
        if guess:
            lang, switched = guess, guess

    if lang == "python":
        static = analyze_python(b.code)
    elif lang in ("javascript", "typescript"):
        static = analyze_javascript(b.code)
    else:
        static = {"issues": [], "metrics": {"complexity": None, "maintainability": None,
                                            "loc": count_loc(b.code), "functions": None}, "valid": True}

    model = pick_model("review", s, b.model)
    ai_issues, ai_status, ai_note = [], "skipped", ""
    mode = "quick" if b.mode == "quick" else "deep"
    calls, drops, t0 = [], [], time.perf_counter()
    CALLS.set(calls)
    DROPS.set(drops)

    if model:
        try:
            ai_issues, ai_status = await ai_review(b.code, lang, static["issues"], model, mode)
        except LLMError as e:
            ai_status, ai_note = "offline", str(e)
    else:
        ai_status, ai_note = "offline", "No model selected in Settings."

    src_lines = b.code.splitlines()
    n_ai = len(ai_issues)
    ai_issues = [x for x in (anchor(i, src_lines, lang) for i in ai_issues) if x]
    note_drop(n_ai - len(ai_issues))
    issues = merge_issues(static["issues"], ai_issues)
    result = {
        "issues": issues, "metrics": static["metrics"], "score": score_of(issues), "breakdown": breakdown(issues),
        "compliance": compliance_of(issues) if lang == "python" and static["valid"] else None,
        "ai_status": ai_status, "ai_note": ai_note, "model": model, "language": lang,
        "switched_language": switched, "mode": mode,
        "seconds": round(time.perf_counter() - t0, 1), "model_calls": len(calls),
        "filtered": sum(drops)
    }

    with closing(db()) as c, c:
        cur = c.execute(
            "INSERT INTO history(ts, language, model, code, analysis, score_before) VALUES(?,?,?,?,?,?)",
            (datetime.now(timezone.utc).isoformat(timespec="seconds"), lang, model, b.code,
             json.dumps(result), result["score"]))
    result["session_id"] = cur.lastrowid
    return result


async def rewrite(task, system, user, lang, model):
    out = extract_code(await chat(task, system, user, model))
    err = validate_code(out, lang)
    if err:
        retry = f"{user}\n\nYour previous answer failed the syntax check ({err}). Return the corrected complete file."
        out = extract_code(await chat(task, system, retry, model))
        err = validate_code(out, lang)
    if err:
        raise HTTPException(422, f"AST-Guard rejected the model's code ({err}). Nothing was changed; try another model.")
    return out


@app.post("/api/refactor")
async def refactor(b: RefactorIn):
    lang, s = b.language.lower(), get_settings()
    model = pick_model("refactor", s, b.model)
    findings = "\n".join(f"- line {i.get('line')}: {i.get('title')}" for i in b.issues[:12])
    user = (f"Language: {lang}\nKnown problems:\n{findings or '- none listed; improve clarity and security'}\n\n"
            f"Code:\n```\n{b.code}\n```")
    task, system = ("fix", REPAIR_SYS) if b.mode == "quick" else ("refactor", REFACTOR_SYS)
    retried = False
    try:
        new_code = await rewrite(task, system, user, lang, model)
        if lang == "python":
            first = analyze_python(new_code)
            bad = [i for i in first["issues"] if i["severity"] in ("critical", "high")]
            if bad:
                retried = True
                listing = "\n".join(f"- line {i['line']}: {i['title']}. {i['detail']}" for i in bad[:8])
                again = (f"{user}\n\nA previous rewrite still has these problems:\n{listing}\n\n"
                         f"Previous rewrite:\n```\n{new_code}\n```\nFix them and return the complete corrected file.")
                try:
                    second = await rewrite(task, system, again, lang, model)
                    if score_of(analyze_python(second)["issues"]) > score_of(first["issues"]):
                        new_code = second
                except (LLMError, HTTPException):
                    pass
    except LLMError as e:
        raise HTTPException(503, str(e))

    result = {"code": new_code, "rows": diff_rows(b.code, new_code), "model": model,
              "ast_guard": "valid" if lang == "python" else "skipped", "changes": [], "retried": retried}
    if lang == "python":
        before, after = analyze_python(b.code), analyze_python(new_code)
        result["remaining"] = after["issues"][:8]
        gone = Counter(i["rule"] for i in before["issues"]) - Counter(i["rule"] for i in after["issues"])
        result.update(before=summarize(before), after=summarize(after),
                      score_before=score_of(before["issues"]), score_after=score_of(after["issues"]),
                      changes=[CHANGE_LABEL[r] for r in gone if r in CHANGE_LABEL])
        bm, am = before["metrics"], after["metrics"]
        if bm and am and am["complexity"] < bm["complexity"] and "Complexity reduced" not in result["changes"]:
            result["changes"].append("Complexity reduced")
    if b.session_id:
        with closing(db()) as c, c:
            c.execute("UPDATE history SET refactor=?, score_after=? WHERE id=?",
                      (json.dumps(result), result.get("score_after"), b.session_id))
    return result


@app.post("/api/quickfix")
async def quickfix(b: FixIn):
    lang, s = b.language.lower(), get_settings()
    model = pick_model("fix", s, b.model)
    i = b.issue
    user = (f"Language: {lang}\nProblem to fix: {i.get('title')} at line {i.get('line')}.\n"
            f"Details: {i.get('detail', '')}\nSuggested approach: {i.get('suggestion', '')}\n\n"
            f"Code:\n```\n{b.code}\n```")
    try:
        new_code = await rewrite("fix", FIX_SYS, user, lang, model)
    except LLMError as e:
        raise HTTPException(503, str(e))
    return {"code": new_code, "rows": diff_rows(b.code, new_code), "model": model}


@app.post("/api/generate-tests")
async def generate_tests(b: CodeActionIn):
    s = get_settings()
    model = pick_model("test", s, b.model)
    user = f"Language: {b.language}\nWrite a complete, executable test suite for the following code:\n```\n{b.code}\n```"
    try:
        test_code = extract_code(await chat("test", TEST_SYS, user, model))
        return {"tests": test_code, "model": model}
    except LLMError as e:
        raise HTTPException(503, str(e))


@app.post("/api/explain")
async def explain_code(b: CodeActionIn):
    s = get_settings()
    model = pick_model("explain", s, b.model)
    user = f"Language: {b.language}\nExplain and analyze this code:\n```\n{b.code}\n```"
    try:
        explanation = await chat("explain", EXPLAIN_SYS, user, model)
        return {"explanation": explanation, "model": model}
    except LLMError as e:
        raise HTTPException(503, str(e))


@app.post("/api/chat-assistant")
async def chat_assistant(b: ChatIn):
    s = get_settings()
    model = pick_model("copilot", s, b.model)
    findings_str = "\n".join(f"- Line {i.get('line')}: {i.get('title')}" for i in b.issues[:10])
    system = f"{COPILOT_SYS}\n\nCurrent File Context ({b.language}):\n```\n{b.code}\n```\nKnown Findings:\n{findings_str or 'None'}"
    try:
        reply = await chat("copilot", system, b.prompt, model, conversation=b.conversation)
        code_block = extract_code(reply) if "```" in reply else None
        return {"reply": reply, "code": code_block, "model": model}
    except LLMError as e:
        raise HTTPException(503, str(e))


@app.post("/api/commit-message")
async def generate_commit_message(b: CommitIn):
    s = get_settings()
    model = pick_model("commit", s)
    diff = "\n".join(difflib.unified_diff(
        b.before_code.splitlines(), b.after_code.splitlines(),
        fromfile="before", tofile="after", lineterm=""
    ))
    user = f"Generate a conventional commit message for this change:\n```diff\n{diff[:4000]}\n```"
    try:
        msg = await chat("commit", COMMIT_SYS, user, model)
        return {"commit_message": msg.strip(), "patch": diff}
    except Exception:
        return {"commit_message": "fix(security): resolve static analysis vulnerabilities and refactor code", "patch": diff}


@app.post("/api/run")
async def run_code(b: RunIn):
    if b.language != "python":
        raise HTTPException(400, "Live execution is currently supported for Python.")
    
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
        f.write(b.code)
        tpath = f.name

    try:
        t0 = time.perf_counter()
        res = subprocess.run(
            [sys.executable, tpath],
            input=b.stdin,
            capture_output=True,
            text=True,
            timeout=5.0,
        )
        duration_ms = round((time.perf_counter() - t0) * 1000)
        return {
            "stdout": res.stdout,
            "stderr": res.stderr,
            "exit_code": res.returncode,
            "duration_ms": duration_ms,
            "timeout": False,
        }
    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": "Execution timed out (5.0s maximum limit). Check for infinite loops or blocking calls.",
            "exit_code": -1,
            "duration_ms": 5000,
            "timeout": True,
        }
    finally:
        try:
            os.remove(tpath)
        except Exception:
            pass


@app.post("/api/run-tests")
async def run_tests(b: RunTestsIn):
    if b.language != "python":
        raise HTTPException(400, "Test runner is currently supported for Python.")

    script = (
        f"{b.code}\n\n"
        f"# --- CodeMind Test Harness ---\n"
        f"{b.test_code}\n\n"
        f"if __name__ == '__main__':\n"
        f"    import unittest\n"
        f"    unittest.main(verbosity=2, exit=False)\n"
    )

    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
        f.write(script)
        tpath = f.name

    try:
        t0 = time.perf_counter()
        res = subprocess.run(
            [sys.executable, tpath],
            capture_output=True,
            text=True,
            timeout=6.0,
        )
        duration_ms = round((time.perf_counter() - t0) * 1000)
        output = res.stdout + ("\n" + res.stderr if res.stderr else "")
        passed = res.returncode == 0 and ("FAILED" not in output)
        return {
            "passed": passed,
            "output": output,
            "exit_code": res.returncode,
            "duration_ms": duration_ms,
        }
    except subprocess.TimeoutExpired:
        return {
            "passed": False,
            "output": "Test execution timed out after 6 seconds.",
            "exit_code": -1,
            "duration_ms": 6000,
        }
    finally:
        try:
            os.remove(tpath)
        except Exception:
            pass


@app.post("/api/project/scan")
async def scan_project(b: ProjectScanIn):
    results = []
    total_issues = 0
    scores = []

    for item in b.files:
        path = item.get("path", "file.py")
        code = item.get("code", "")
        lang = item.get("language", "python").lower()

        if lang == "python":
            analysis = analyze_python(code)
        elif lang in ("javascript", "typescript"):
            analysis = analyze_javascript(code)
        else:
            analysis = {"issues": [], "metrics": {"loc": count_loc(code)}, "valid": True}

        score = score_of(analysis["issues"])
        scores.append(score)
        total_issues += len(analysis["issues"])

        results.append({
            "path": path,
            "language": lang,
            "score": score,
            "issues": analysis["issues"],
            "metrics": analysis["metrics"],
        })

    avg_score = round(sum(scores) / len(scores)) if scores else 100
    return {
        "files_count": len(results),
        "total_issues": total_issues,
        "repo_score": avg_score,
        "files": results,
    }


# ───────────────────────── History & Exports ─────────────────────────

@app.get("/api/history")
def history():
    with closing(db()) as c:
        rows = c.execute("SELECT * FROM history ORDER BY id DESC LIMIT 100").fetchall()
    out = []
    for r in rows:
        a = json.loads(r["analysis"])
        first = next((l.strip() for l in r["code"].splitlines() if l.strip()), "")
        out.append({"id": r["id"], "ts": r["ts"], "language": r["language"], "model": r["model"],
                    "score_before": r["score_before"], "score_after": r["score_after"],
                    "issues": len(a["issues"]), "preview": first[:80]})
    return out


def load_row(sid):
    with closing(db()) as c:
        row = c.execute("SELECT * FROM history WHERE id=?", (sid,)).fetchone()
    if not row:
        raise HTTPException(404, "That session no longer exists.")
    return row


@app.get("/api/history/{sid}")
def history_item(sid: int):
    r = load_row(sid)
    analysis = json.loads(r["analysis"])
    analysis["session_id"] = r["id"]
    return {"code": r["code"], "language": r["language"], "review": analysis,
            "refactor": json.loads(r["refactor"]) if r["refactor"] else None}


@app.delete("/api/history/{sid}")
def history_delete(sid: int):
    with closing(db()) as c, c:
        c.execute("DELETE FROM history WHERE id=?", (sid,))
    return {"ok": True}


@app.delete("/api/history")
def history_clear_all():
    with closing(db()) as c, c:
        c.execute("DELETE FROM history")
    return {"ok": True, "message": "All history cleared"}


@app.get("/api/history/{sid}/report", response_class=PlainTextResponse)
def report(sid: int):
    r = load_row(sid)
    a = json.loads(r["analysis"])
    ref = json.loads(r["refactor"]) if r["refactor"] else None
    out = ["# CodeMind Security & Code Audit Report", "",
           f"- **Date**: {r['ts']}",
           f"- **Language**: {r['language']}",
           f"- **Model**: {r['model'] or 'Static Engine'}",
           f"- **Initial Health Score**: {r['score_before']}/100" + (f" -> **Post-Refactor**: {r['score_after']}/100" if r["score_after"] is not None else ""),
           "", "## Executive Findings Summary", ""]
    if a["issues"]:
        out += ["| Severity | Line | Finding | Source | Compliance Standards |", "|---|---|---|---|---|"]
        out += [f"| {i['severity'].upper()} | {i['line']} | {i['title']} | {i['source']} | {', '.join(i['standards']) or '-'} |"
                for i in a["issues"]]
    else:
        out.append("✅ No security or logic defects detected.")

    if a.get("compliance"):
        out += ["", f"## OWASP & CWE Compliance Matrix ({a['compliance']['percent']}% Passing)", "",
                "| Security Control | Benchmark Reference | Status | Findings |", "|---|---|---|---|"]
        out += [f"| {x['name']} | {x['cwe']} | {'PASS' if x['status'] == 'pass' else 'FAIL'} | {x['count']} |"
                for x in a["compliance"]["rows"]]

    if ref:
        out += ["", "## Automated Refactoring Verification", "", f"- **AST-Guard Verification**: {ref['ast_guard']}"]
        if ref.get("before") and ref.get("after"):
            out += [
                f"- **Cyclomatic Complexity**: {ref['before']['complexity']} -> {ref['after']['complexity']}",
                f"- **Maintainability Index**: {ref['before']['maintainability']} -> {ref['after']['maintainability']}",
                f"- **Resolved Issues**: {ref['before']['issues']} -> {ref['after']['issues']}"
            ]
        if ref.get("changes"):
            out += ["", "### Applied Transformations:"]
            out += [f"- [x] {c}" for c in ref["changes"]]

    out += ["", "## Source Code Reviewed", "", f"```{r['language']}", r["code"], "```", ""]
    return "\n".join(out)


@app.get("/api/history/{sid}/report-html", response_class=HTMLResponse)
def report_html(sid: int):
    r = load_row(sid)
    a = json.loads(r["analysis"])

    findings_rows = ""
    for i in a.get("issues", []):
        sev_color = "#ef4444" if i["severity"] == "critical" else "#f97316" if i["severity"] == "high" else "#eab308" if i["severity"] == "medium" else "#38bdf8"
        findings_rows += f"""
        <tr>
            <td><span style="background:{sev_color}22; color:{sev_color}; padding:2px 8px; border-radius:4px; font-weight:700;">{i['severity'].upper()}</span></td>
            <td>Line {i['line']}</td>
            <td><b>{i['title']}</b><br><small style="color:#64748b;">{i['detail']}</small></td>
            <td>{i['source']}</td>
            <td>{', '.join(i['standards']) or '-'}</td>
        </tr>
        """

    html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>CodeMind Audit Report #{r['id']}</title>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 40px; line-height: 1.6; }}
        .container {{ max-width: 900px; margin: 0 auto; background: #1e293b; padding: 36px; border-radius: 12px; border: 1px solid #334155; }}
        h1 {{ margin-top: 0; color: #38bdf8; display: flex; align-items: center; gap: 10px; }}
        .badge {{ background: #6366f1; color: #fff; padding: 3px 8px; border-radius: 6px; font-size: 13px; }}
        .meta-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 20px 0; background: #0f172a; padding: 16px; border-radius: 8px; }}
        .score {{ font-size: 28px; font-weight: 800; color: {'#10b981' if r['score_before'] >= 80 else '#f59e0b' if r['score_before'] >= 50 else '#ef4444'}; }}
        table {{ width: 100%; border-collapse: collapse; margin: 20px 0; }}
        th, td {{ text-align: left; padding: 12px; border-bottom: 1px solid #334155; font-size: 14px; }}
        th {{ background: #0f172a; color: #94a3b8; }}
        pre {{ background: #0f172a; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; color: #e2e8f0; }}
    </style>
</head>
<body>
    <div class="container">
        <h1>CodeMind Security Audit Report <span class="badge">#{r['id']}</span></h1>
        <div class="meta-grid">
            <div><small style="color:#94a3b8;">AUDIT DATE</small><br><b>{r['ts']}</b></div>
            <div><small style="color:#94a3b8;">LANGUAGE</small><br><b>{r['language'].upper()}</b></div>
            <div><small style="color:#94a3b8;">HEALTH SCORE</small><br><span class="score">{r['score_before']}/100</span></div>
            <div><small style="color:#94a3b8;">ENGINE / MODEL</small><br><b>{r['model'] or 'Static Engine'}</b></div>
        </div>
        <h2>Vulnerability Findings ({len(a.get('issues', []))})</h2>
        <table>
            <thead><tr><th>Severity</th><th>Line</th><th>Finding</th><th>Source</th><th>Standards</th></tr></thead>
            <tbody>{findings_rows or '<tr><td colspan="5">No issues detected.</td></tr>'}</tbody>
        </table>
        <h2>Source Reviewed</h2>
        <pre><code>{r['code']}</code></pre>
    </div>
</body>
</html>"""
    return HTMLResponse(content=html)


@app.get("/api/history/{sid}/sarif")
def report_sarif(sid: int):
    r = load_row(sid)
    a = json.loads(r["analysis"])
    issues = a.get("issues", [])

    sarif_rules = {}
    sarif_results = []
    level_map = {"critical": "error", "high": "error", "medium": "warning", "low": "note"}

    for it in issues:
        rule_id = it.get("rule") or f"CM-{it.get('category', 'logic').upper()}"
        if rule_id not in sarif_rules:
            sarif_rules[rule_id] = {
                "id": rule_id,
                "name": it.get("title", ""),
                "shortDescription": {"text": it.get("title", "")},
                "fullDescription": {"text": it.get("detail", "")},
                "help": {"text": it.get("suggestion", "")},
            }
        sarif_results.append({
            "ruleId": rule_id,
            "level": level_map.get(it.get("severity", "medium"), "warning"),
            "message": {"text": f"{it.get('title')}: {it.get('detail')}"},
            "locations": [{
                "physicalLocation": {
                    "artifactLocation": {"uri": f"file.{r['language']}"},
                    "region": {"startLine": int(it.get("line", 1))},
                }
            }],
        })

    sarif_data = {
        "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {
                "driver": {
                    "name": "CodeMind",
                    "informationUri": "https://github.com/codemind",
                    "rules": list(sarif_rules.values()),
                }
            },
            "results": sarif_results,
        }],
    }
    return JSONResponse(content=sarif_data)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
