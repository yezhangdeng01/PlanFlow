// test/obsidian-mock.ts
var TFile = class {
};
function parseYaml(src) {
  const lines = src.split("\n");
  let pos = 0;
  const indentOf = (l) => l.search(/\S/);
  const stripComment = (s) => s;
  function parseNode(indent) {
    while (pos < lines.length) {
      const line = lines[pos];
      if (!line.trim() || line.trim().startsWith("#")) {
        pos++;
        continue;
      }
      break;
    }
    if (pos >= lines.length)
      return null;
    const first = lines[pos];
    if (indentOf(first) < indent)
      return null;
    if (first.trim().startsWith("- ")) {
      const arr = [];
      while (pos < lines.length) {
        const line = lines[pos];
        if (indentOf(line) < indent)
          break;
        if (!line.trim() || line.trim().startsWith("#")) {
          pos++;
          continue;
        }
        if (!line.trim().startsWith("- "))
          break;
        const content = stripComment(line.trim().slice(2).trim());
        const lineIndent = indentOf(line);
        if (content === "" || content.endsWith(":")) {
          pos++;
          arr.push(parseNode(lineIndent + 2));
        } else {
          const idx = content.indexOf(":");
          if (idx !== -1) {
            const obj2 = {};
            const key = content.slice(0, idx).trim();
            const val = content.slice(idx + 1).trim();
            obj2[key] = val === "" ? parseNode(lineIndent + 2) : val;
            pos++;
            while (pos < lines.length) {
              const nl = lines[pos];
              if (indentOf(nl) <= lineIndent)
                break;
              const nidx = nl.trim().indexOf(":");
              if (nidx === -1) {
                pos++;
                continue;
              }
              const nkey = nl.trim().slice(0, nidx).trim();
              const nval = stripComment(nl.trim().slice(nidx + 1).trim());
              obj2[nkey] = nval === "" ? parseNode(indentOf(nl) + 2) : nval;
              pos++;
            }
            arr.push(obj2);
          } else {
            arr.push(content);
            pos++;
          }
        }
      }
      return arr;
    }
    const obj = {};
    while (pos < lines.length) {
      const line = lines[pos];
      if (indentOf(line) < indent)
        break;
      if (!line.trim() || line.trim().startsWith("#")) {
        pos++;
        continue;
      }
      const idx = line.trim().indexOf(":");
      if (idx === -1) {
        pos++;
        continue;
      }
      const key = line.trim().slice(0, idx).trim();
      const val = stripComment(line.trim().slice(idx + 1).trim());
      if (val === "") {
        pos++;
        obj[key] = parseNode(indentOf(line) + 2);
      } else {
        obj[key] = val;
        pos++;
      }
    }
    return obj;
  }
  return parseNode(0);
}

// src/daily.ts
var TASK_LINE_RE = /^- \[([ x])\] (.+?)(?: #计划\/(\S+))?(?: 🛫 (\d{4}-\d{2}-\d{2}))?(?: 📅 (\d{4}-\d{2}-\d{2}))?$/;
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseDateString(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function weekRange(dateStr) {
  const d = parseDateString(dateStr);
  const day = d.getDay() || 7;
  const start = addDays(d, 1 - day);
  return { start: formatDate(start), end: formatDate(addDays(start, 6)) };
}

// src/tasks.ts
function parseTaskPool(file2, content) {
  var _a6, _b, _c;
  const tasks2 = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = TASK_LINE_RE.exec(lines[i]);
    if (!m)
      continue;
    tasks2.push({
      text: m[2].trim(),
      plan: (_a6 = m[3]) != null ? _a6 : null,
      checked: m[1] === "x",
      start: (_b = m[4]) != null ? _b : null,
      due: (_c = m[5]) != null ? _c : null,
      line: i,
      raw: lines[i],
      file: file2
    });
  }
  return tasks2;
}
function buildPoolLine({ text, plan, start, due }) {
  let line = `- [ ] ${text.trim()}`;
  if (plan && plan.trim())
    line += ` #\u8BA1\u5212/${plan.trim()}`;
  if (start)
    line += ` \u{1F6EB} ${start}`;
  if (due)
    line += ` \u{1F4C5} ${due}`;
  return line;
}
var DAY_MS = 864e5;
var AUTO_UNIT_RE = /（第\s*(\d+)\s*(?:篇|本|条|个|部|期|集|次|份|张|幅|门|天)）$/;
function planCounterUnit(target) {
  const m = /(\d+)\s*(篇|本|条|个|部|期|集|次|份|张|幅|门|天)/.exec(target);
  return m ? m[2] : "\u7BC7";
}
function isAutoTask(task) {
  return AUTO_UNIT_RE.test(task.text.trim());
}
function autoWeekContext(planStart, planEnd, today) {
  if (today < planStart || today > planEnd)
    return null;
  const startMon = weekRange(planStart).start;
  const endMon = weekRange(planEnd).start;
  const thisMon = weekRange(today).start;
  if (thisMon < startMon || thisMon > endMon)
    return null;
  const totalWeeks = Math.round((parseDateString(endMon).getTime() - parseDateString(startMon).getTime()) / (DAY_MS * 7)) + 1;
  const rawIndex = Math.round((parseDateString(thisMon).getTime() - parseDateString(startMon).getTime()) / (DAY_MS * 7)) + 1;
  const weekIndex = Math.max(1, Math.min(rawIndex, Math.max(totalWeeks, 1)));
  return { weekIndex, totalWeeks, weekStart: thisMon, weekEnd: weekRange(today).end };
}
function autoQuota(targetCount, weekIndex, totalWeeks) {
  if (targetCount <= 0 || totalWeeks <= 0)
    return 0;
  return Math.ceil(targetCount * weekIndex / totalWeeks);
}
function autoTaskNumbers(existingAuto, need, targetCount, label, unit) {
  let maxN = 0;
  for (const t of existingAuto) {
    const m = AUTO_UNIT_RE.exec(t.text.trim());
    if (m)
      maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  const nums = [];
  let n = maxN + 1;
  while (nums.length < need && n <= targetCount) {
    const name = `${label}\uFF08\u7B2C ${n} ${unit}\uFF09`;
    if (!existingAuto.some((t) => t.text.trim() === name))
      nums.push(n);
    n++;
  }
  return nums;
}

// src/stats.ts
function filterTasksInRange(tasks2, start, end) {
  return tasks2.filter((t) => {
    var _a6, _b;
    const s = (_a6 = t.start) != null ? _a6 : t.due;
    const e = (_b = t.due) != null ? _b : t.start;
    if (!s || !e)
      return false;
    return s <= end && e >= start;
  });
}
function summarizeTasks(tasks2) {
  const total = tasks2.length;
  const done = tasks2.filter((t) => t.checked).length;
  return { total, done, percent: total === 0 ? 0 : Math.round(done / total * 100) };
}
function parsePlansFromFrontmatter(content) {
  var _a6, _b, _c;
  const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!fmMatch)
    return [];
  let data;
  try {
    data = parseYaml(fmMatch[1]);
  } catch (e) {
    return [];
  }
  const raw = data == null ? void 0 : data.plans;
  if (raw === void 0 || raw === null)
    return [];
  const defs = [];
  const push = (name, obj) => {
    var _a7;
    const trimmed = name.trim();
    if (!trimmed)
      return;
    const target = readPlanTarget(obj);
    const type = readPlanType(obj, target);
    const m = (_a7 = /(\d+)\s*(?:篇|条|个|部|期|集|次|份|张|幅|本|门|篇)/.exec(target)) != null ? _a7 : /(?<![0-9/%])(\d+)(?![0-9/%])/.exec(target);
    defs.push({
      name: trimmed,
      type,
      target,
      targetCount: type === "numeric" && m ? parseInt(m[1], 10) : 0
    });
  };
  if (Array.isArray(raw)) {
    for (const el of raw) {
      if (typeof el === "string") {
        const s = el.trim();
        const idx = s.indexOf(":");
        if (idx !== -1)
          push(s.slice(0, idx), { target: s.slice(idx + 1).trim() });
        else {
          const m = /^(\S+)\s+(.+)$/.exec(s);
          if (m)
            push(m[1], { target: m[2] });
          else
            push(s, void 0);
        }
      } else if (el && typeof el === "object") {
        const obj = el;
        const name = (_c = (_b = (_a6 = obj.name) != null ? _a6 : obj.plan) != null ? _b : obj["\u540D\u79F0"]) != null ? _c : obj["\u8BA1\u5212"];
        if (typeof name === "string") {
          push(name, obj);
        } else {
          const key = Object.keys(obj)[0];
          if (key) {
            const val = obj[key];
            push(
              key,
              val && typeof val === "object" ? val : { target: typeof val === "string" ? val : "" }
            );
          }
        }
      }
    }
  } else if (typeof raw === "object") {
    for (const key of Object.keys(raw)) {
      const val = raw[key];
      if (val && typeof val === "object")
        push(key, val);
      else if (typeof val === "string")
        push(key, { target: val });
      else
        push(key, void 0);
    }
  }
  return defs;
}
function readPlanTarget(obj) {
  if (!obj)
    return "";
  for (const k of ["target", "description", "desc", "\u76EE\u6807", "\u63CF\u8FF0", "goal", "\u503C"]) {
    if (typeof obj[k] === "string")
      return obj[k];
  }
  return "";
}
function readPlanType(obj, target) {
  let t = "";
  if (obj) {
    for (const k of ["type", "kind", "\u7C7B\u578B", "\u6A21\u5F0F"]) {
      if (typeof obj[k] === "string") {
        t = obj[k];
        break;
      }
    }
  }
  if (t) {
    if (/数量|量化|count|numeric|project|任务|篇|个|次/.test(t))
      return "numeric";
    if (/打卡|习惯|habit|check|daily|复盘/.test(t))
      return "check";
  }
  if (/\d+\s*(?:篇|条|个|部|期|集|次|份|张|幅|本|门)/.test(target))
    return "numeric";
  return "check";
}

// test/parse-test.ts
var failed = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS" : "FAIL") + " | " + name + (detail !== void 0 ? " | " + JSON.stringify(detail) : ""));
  if (!cond)
    failed++;
}
var fm1 = `---
type: year
year: 2026
plans:
  - name: \u5199\u4F5C
    type: \u6570\u91CF
    target: 12 \u7BC7\u516C\u4F17\u53F7\u6587\u7AE0
  - name: \u5065\u5EB7
    type: \u6253\u5361
    target: \u6BCF\u5929\u8DD1\u6B65 1 \u5C0F\u65F6
---
# \u5E74\u5EA6\u8BA1\u5212
`;
var defs1 = parsePlansFromFrontmatter(fm1);
console.log("defs1:", JSON.stringify(defs1));
check("array form: 2 plans", defs1.length === 2, defs1.length);
var writing = defs1.find((d) => d.name === "\u5199\u4F5C");
check("\u5199\u4F5C is numeric", (writing == null ? void 0 : writing.type) === "numeric");
check("\u5199\u4F5C target", (writing == null ? void 0 : writing.target) === "12 \u7BC7\u516C\u4F17\u53F7\u6587\u7AE0");
check("\u5199\u4F5C targetCount = 12", (writing == null ? void 0 : writing.targetCount) === 12);
var health = defs1.find((d) => d.name === "\u5065\u5EB7");
check("\u5065\u5EB7 is check", (health == null ? void 0 : health.type) === "check", health == null ? void 0 : health.type);
check("\u5065\u5EB7 targetCount = 0 (check)", (health == null ? void 0 : health.targetCount) === 0);
var fm2 = `---
plans:
  \u5199\u4F5C:
    type: \u6570\u91CF
    target: 12 \u7BC7\u516C\u4F17\u53F7\u6587\u7AE0
  \u590D\u76D8:
    type: \u6253\u5361
    target: \u6BCF\u5929\u590D\u76D8
---
`;
var defs2 = parsePlansFromFrontmatter(fm2);
console.log("defs2:", JSON.stringify(defs2));
check("map form: 2 plans", defs2.length === 2, defs2.length);
check("map form name", defs2.some((d) => d.name === "\u5199\u4F5C"));
var _a;
check("map form check type", ((_a = defs2.find((d) => d.name === "\u590D\u76D8")) == null ? void 0 : _a.type) === "check");
var fm3 = `---
plans:
  - name: \u5B66\u4E60
    target: 50 \u672C\u4E66
  - name: \u51A5\u60F3
    target: \u575A\u6301\u6BCF\u5929\u51A5\u60F3
---
`;
var defs3 = parsePlansFromFrontmatter(fm3);
console.log("defs3:", JSON.stringify(defs3));
var _a2;
check("fallback numeric (50 \u672C\u4E66)", ((_a2 = defs3.find((d) => d.name === "\u5B66\u4E60")) == null ? void 0 : _a2.type) === "numeric");
var _a3;
check("fallback check (no number)", ((_a3 = defs3.find((d) => d.name === "\u51A5\u60F3")) == null ? void 0 : _a3.type) === "check");
var file = new TFile();
var poolContent = [
  "- [ ] \u5B8C\u6210\u300A\u970D\u53BB\u75C5\u300B\u6587\u7AE0 #\u8BA1\u5212/\u5199\u4F5C \u{1F6EB} 2026-08-10 \u{1F4C5} 2026-08-16",
  "- [x] \u6574\u7406 AI \u753B\u56FE\u5DE5\u4F5C\u6D41 #\u8BA1\u5212/\u5B66\u4E60 \u{1F6EB} 2026-08-12 \u{1F4C5} 2026-08-14",
  "- [ ] \u65E0\u8BA1\u5212\u7684\u4E34\u65F6\u4EFB\u52A1 \u{1F4C5} 2026-08-11"
].join("\n");
var pool = parseTaskPool(file, poolContent);
console.log("pool:", JSON.stringify(pool.map((t) => ({ text: t.text, plan: t.plan, checked: t.checked, start: t.start, due: t.due, line: t.line }))));
check("pool parses 3 tasks", pool.length === 3, pool.length);
var t0 = pool[0];
check("task0 fields", t0.text === "\u5B8C\u6210\u300A\u970D\u53BB\u75C5\u300B\u6587\u7AE0" && t0.plan === "\u5199\u4F5C" && t0.start === "2026-08-10" && t0.due === "2026-08-16" && !t0.checked);
check("task0 line", t0.line === 0);
check("task1 checked", pool[1].checked === true);
check("task2 plan null", pool[2].plan === null && pool[2].due === "2026-08-11");
var built = buildPoolLine({ text: "\u65B0\u4EFB\u52A1", plan: "\u5199\u4F5C", start: "2026-08-10", due: "2026-08-16" });
check("buildPoolLine", built === "- [ ] \u65B0\u4EFB\u52A1 #\u8BA1\u5212/\u5199\u4F5C \u{1F6EB} 2026-08-10 \u{1F4C5} 2026-08-16", built);
var rebuilt = parseTaskPool(file, built);
check("build\u2192parse round-trip", rebuilt.length === 1 && rebuilt[0].text === "\u65B0\u4EFB\u52A1" && rebuilt[0].plan === "\u5199\u4F5C" && rebuilt[0].start === "2026-08-10" && rebuilt[0].due === "2026-08-16");
var built2 = buildPoolLine({ text: "\u7B80\u5355\u4EFB\u52A1", plan: null, start: null, due: null });
check("buildPoolLine minimal", built2 === "- [ ] \u7B80\u5355\u4EFB\u52A1", built2);
var tasks = pool;
var week = filterTasksInRange(tasks, "2026-08-10", "2026-08-16");
check("week filter includes all 3", week.length === 3, week.map((t) => t.text));
var month = filterTasksInRange(tasks, "2026-08-01", "2026-08-31");
check("month filter includes all dated", month.length === 3, month.map((t) => t.text));
var none = filterTasksInRange(tasks, "2026-09-01", "2026-09-30");
check("sep filter empty", none.length === 0, none.length);
check("summarize", JSON.stringify(summarizeTasks(tasks)) === '{"total":3,"done":1,"percent":33}', JSON.stringify(summarizeTasks(tasks)));
var undated = parseTaskPool(file, "- [ ] \u672A\u5B89\u6392\u65E5\u671F\n");
check("undated excluded", filterTasksInRange(undated, "2026-08-10", "2026-08-16").length === 0);
var fm7 = `---
plans:
  \u5199\u4F5C: 12 \u7BC7\u516C\u4F17\u53F7\u6587\u7AE0
  \u5065\u5EB7: \u6BCF\u5929\u8DD1\u6B65
---
`;
var defs7 = parsePlansFromFrontmatter(fm7);
console.log("defs7:", JSON.stringify(defs7));
check("single-key map 2 plans", defs7.length === 2, defs7.length);
var _a4;
check("single-key \u5199\u4F5C numeric", ((_a4 = defs7.find((d) => d.name === "\u5199\u4F5C")) == null ? void 0 : _a4.type) === "numeric");
var _a5;
check("single-key \u5065\u5EB7 check", ((_a5 = defs7.find((d) => d.name === "\u5065\u5EB7")) == null ? void 0 : _a5.type) === "check");
check("planCounterUnit \u7BC7", planCounterUnit("12 \u7BC7\u516C\u4F17\u53F7\u6587\u7AE0") === "\u7BC7");
check("planCounterUnit \u5929", planCounterUnit("144 \u5929") === "\u5929");
check("planCounterUnit default", planCounterUnit("\u6BCF\u5929\u8DD1\u6B65") === "\u7BC7");
check("autoQuota w1 (12/52)", autoQuota(12, 1, 52) === 1, autoQuota(12, 1, 52));
check("autoQuota w26 (12/52)", autoQuota(12, 26, 52) === 6, autoQuota(12, 26, 52));
check("autoQuota w52 (12/52)", autoQuota(12, 52, 52) === 12, autoQuota(12, 52, 52));
check("autoQuota target 0", autoQuota(0, 5, 52) === 0);
check("autoQuota increments \u2264 2", Array.from({ length: 52 }, (_, i) => autoQuota(12, i + 1, 52) - autoQuota(12, i, 52)).every((d) => d >= 0 && d <= 2));
var ctx1 = autoWeekContext("2026-01-01", "2026-12-31", "2026-01-05");
console.log("ctx1:", JSON.stringify(ctx1));
check("weekContext full-year totalWeeks = 53 (2026 has 53 ISO weeks)", (ctx1 == null ? void 0 : ctx1.totalWeeks) === 53, ctx1 == null ? void 0 : ctx1.totalWeeks);
check("weekContext first week index = 2", (ctx1 == null ? void 0 : ctx1.weekIndex) === 2, ctx1 == null ? void 0 : ctx1.weekIndex);
check("weekContext before plan start \u2192 null", autoWeekContext("2026-08-10", "2026-12-31", "2026-08-01") === null);
check("weekContext after plan end \u2192 null", autoWeekContext("2026-08-10", "2026-12-31", "2027-01-04") === null);
check("weekContext same week before start \u2192 null", autoWeekContext("2026-08-12", "2026-12-31", "2026-08-10") === null);
var ctx2 = autoWeekContext("2026-08-10", "2026-12-31", "2026-08-10");
check("weekContext mid-plan totalWeeks", (ctx2 == null ? void 0 : ctx2.totalWeeks) === 21, ctx2 == null ? void 0 : ctx2.totalWeeks);
check("weekContext mid-plan week1", (ctx2 == null ? void 0 : ctx2.weekIndex) === 1, ctx2 == null ? void 0 : ctx2.weekIndex);
var ctx3 = autoWeekContext("2026-08-10", "2026-12-31", "2026-08-17");
check("weekContext mid-plan week2", (ctx3 == null ? void 0 : ctx3.weekIndex) === 2, ctx3 == null ? void 0 : ctx3.weekIndex);
var autoPool = parseTaskPool(
  file,
  [
    "- [ ] \u5199\u4F5C\uFF08\u7B2C 1 \u7BC7\uFF09 #\u8BA1\u5212/\u5199\u4F5C \u{1F6EB} 2026-08-10 \u{1F4C5} 2026-08-16",
    "- [x] \u5199\u4F5C\uFF08\u7B2C 2 \u7BC7\uFF09 #\u8BA1\u5212/\u5199\u4F5C \u{1F6EB} 2026-08-10 \u{1F4C5} 2026-08-16",
    "- [ ] \u5B8C\u6210\u300A\u970D\u53BB\u75C5\u300B\u6587\u7AE0 #\u8BA1\u5212/\u5199\u4F5C \u{1F6EB} 2026-08-10 \u{1F4C5} 2026-08-16",
    "- [ ] \u5B66\u4E60\uFF08\u7B2C 1 \u672C\uFF09 #\u8BA1\u5212/\u5B66\u4E60 \u{1F6EB} 2026-08-10 \u{1F4C5} 2026-08-16"
  ].join("\n")
);
check("isAutoTask \u7B2C1\u7BC7", autoPool[0].plan === "\u5199\u4F5C" && isAutoTask(autoPool[0]));
check("isAutoTask \u7B2C2\u7BC7 checked", autoPool[1].plan === "\u5199\u4F5C" && isAutoTask(autoPool[1]));
check("manual task not auto", autoPool[2].plan === "\u5199\u4F5C" && !isAutoTask(autoPool[2]));
check("isAutoTask \u7B2C1\u672C (book unit)", autoPool[3].plan === "\u5B66\u4E60" && isAutoTask(autoPool[3]));
var autoWriting = autoPool.filter((t) => t.plan === "\u5199\u4F5C");
var nums1 = autoTaskNumbers(autoWriting, 1, 12, "\u5199\u4F5C", "\u7BC7");
check("autoTaskNumbers continue from maxN", JSON.stringify(nums1) === "[3]", nums1);
var gapPool = parseTaskPool(
  file,
  ["- [ ] \u5199\u4F5C\uFF08\u7B2C 1 \u7BC7\uFF09 #\u8BA1\u5212/\u5199\u4F5C \u{1F6EB} 2026-08-10 \u{1F4C5} 2026-08-16", "- [ ] \u5199\u4F5C\uFF08\u7B2C 3 \u7BC7\uFF09 #\u8BA1\u5212/\u5199\u4F5C \u{1F6EB} 2026-08-10 \u{1F4C5} 2026-08-16"].join("\n")
);
var numsGap = autoTaskNumbers(gapPool, 2, 12, "\u5199\u4F5C", "\u7BC7");
check("autoTaskNumbers skip deleted middle", JSON.stringify(numsGap) === "[4,5]", numsGap);
check("autoTaskNumbers need 0", autoTaskNumbers(autoWriting, 0, 12, "\u5199\u4F5C", "\u7BC7").length === 0);
var numsCap = autoTaskNumbers(autoWriting, 5, 2, "\u5199\u4F5C", "\u7BC7");
check("autoTaskNumbers capped at targetCount", JSON.stringify(numsCap) === "[]", numsCap);
var numsEmpty = autoTaskNumbers([], 2, 12, "\u5199\u4F5C", "\u7BC7");
check("autoTaskNumbers from scratch", JSON.stringify(numsEmpty) === "[1,2]", numsEmpty);
console.log(failed === 0 ? "\nALL PASSED" : `
${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
