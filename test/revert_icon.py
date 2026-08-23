# -*- coding: utf-8 -*-
# Revert icon: remove addIcon usage, ribbon & settings back to native icon
import re, json, io, os

# main.ts
s = open("main.ts", encoding="utf-8").read()
s = s.replace('import { addIcon, Notice, Plugin } from "obsidian";', 'import { Notice, Plugin } from "obsidian";')
s = s.replace('import { PLANFLOW_LOGO_SVG } from "./src/icon";\n', "")
s = re.sub(r"\t\t// v1\.2: 注册专属品牌图标[^\n]*\n\t\taddIcon\(\"planflow-logo\", PLANFLOW_LOGO_SVG\);\n\n", "", s)
s = s.replace('this.addRibbonIcon("planflow-logo"', 'this.addRibbonIcon("layout-dashboard"')
open("main.ts", "w", encoding="utf-8").write(s)

# settings.ts
t = open("src/settings.ts", encoding="utf-8").read()
t = t.replace('icon: "planflow-logo",', 'icon: "layout-dashboard",')
open("src/settings.ts", "w", encoding="utf-8").write(t)

# remove icon module
if os.path.exists("src/icon.ts"):
    os.remove("src/icon.ts")
    print("icon.ts removed")

# local data.json
path = "E:/文档/workbuddy/Obsidian库/.obsidian/plugins/planflow/data.json"
with io.open(path, encoding="utf-8") as f:
    d = json.load(f)
d["icon"] = "layout-dashboard"
with io.open(path, "w", encoding="utf-8") as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
print("data.json icon -> layout-dashboard")
print("revert done")
