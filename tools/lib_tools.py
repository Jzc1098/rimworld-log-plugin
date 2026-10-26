"""从 index.js 的注册 + tools/tools.json 的用途给出工具清单，供文档生成器共用。"""
import json
import os
import re

_PUSH_RE = re.compile(r"toolsRegistered\.push\(\s*'([A-Za-z0-9_]+)'\s*\)")


def read_tools(index_js_path):
    here = os.path.dirname(os.path.abspath(__file__))
    purposes = {}
    cfg = os.path.join(here, 'tools.json')
    if os.path.isfile(cfg):
        with open(cfg, encoding='utf-8') as handle:
            for item in json.load(handle):
                purposes[item.get('name', '')] = item.get('purpose', '')
    names = []
    if os.path.isfile(index_js_path):
        with open(index_js_path, encoding='utf-8') as handle:
            source = handle.read()
        for match in _PUSH_RE.finditer(source):
            name = match.group(1)
            if name not in names:
                names.append(name)
    tools = []
    for name in names:
        tools.append({'name': name, 'purpose': purposes.get(name, '（tools.json 里缺这个工具的用途）')})
    for name, purpose in purposes.items():
        if name and name not in names:
            tools.append({'name': name, 'purpose': '（tools.json 有、但 index.js 未注册，疑似改名）' + purpose})
    return tools