import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import "./styles.css";
import {
  NodeGraphEditor,
  GraphConfigProvider,
  useBuildGraphConfig,
} from "@clarkmcc/ngraph";
import {
  Background,
  BackgroundVariant,
  ReactFlowProvider,
  useReactFlow,
  useNodes,
  useEdges,
} from "@xyflow/react";

// --- Rust Model Definitions (TypeScript Equivalents) ---

export type Ustr = string;

export interface Trigger {
  script?: Ustr;
  exec?: Ustr;
  args?: Ustr[];
  state?: Ustr;
  signal?: Ustr;
  service?: Ustr;
  timer?: Ustr;
  socket?: Ustr;
  stop?: boolean;
  payload?: any;
}

export interface State {
  name: Ustr;
  payload: string;
  "activate-on-none"?: Ustr[];
  after?: any[];
  branch?: Ustr[];
  "auto-payload"?: any;
  subscribers?: any[];
  broadcast?: Ustr[];
  permissions?: number[];
}

export interface Signal {
  name: Ustr;
  payload: string;
  after?: any[];
  branch?: Ustr[];
  subscribers?: any[];
  broadcast?: Ustr[];
  permissions?: number[];
}

export interface Mount {
  source?: Ustr;
  target: Ustr;
  fstype?: Ustr;
  flags?: string[];
  data?: string;
  create?: boolean;
  after?: Ustr[];
  is_mounted: boolean;
}

export interface NetworkConfig {
  name: Ustr;
  method: string;
  address?: Ustr;
  gateway?: Ustr;
  dns?: Ustr[];
  route?: any[];
  configured: boolean;
}

export interface Service {
  name: Ustr;
  run: any;
  after?: Ustr[];
  "start-on"?: any[];
  "stop-on"?: any[];
  "on-start"?: Trigger[];
  "on-stop"?: Trigger[];
  "working-dir"?: Ustr;
  space: string;
  singleton: boolean;
  "user-source"?: { state: Ustr; "username-field": string; "match-branch-key"?: string };
  transport?: any;
  branching?: { enabled: boolean; "source-state": Ustr; key?: string; "max-instances"?: number };
  restart?: any;
}

export interface Socket {
  name: Ustr;
  listen: string;
  type: string;
  owner?: Ustr;
  "start-on"?: any[];
  "stop-on"?: any[];
  "on-start"?: Trigger[];
  trigger?: Trigger[];
  "on-stop"?: Trigger[];
  lifecycle: string;
}

export interface Timer {
  name: Ustr;
  duration: Ustr;
  after?: Ustr[];
  finish?: Trigger[];
}

export interface Variable {
  name: Ustr;
  default?: any;
  env?: Ustr;
}

const SCHEMAS: Record<string, string[]> = {
  service: ["name", "run", "after", "branching", "restart", "start-on", "stop-on", "on-start", "on-stop", "transport", "working_dir", "space", "user_source", "singleton"],
  state: ["name", "payload", "activate-on-none", "after", "branch", "auto-payload", "subscribers", "broadcast", "permissions"],
  signal: ["name", "payload", "after", "branch", "subscribers", "broadcast", "permissions"],
  socket: ["name", "listen", "type", "owner", "start_on", "lifecycle", "trigger", "stop_on", "on_start", "on_stop", "on_data"],
  timer: ["name", "duration", "after", "finish"],
  mount: ["target", "source", "fstype", "flags", "data", "create", "after"],
  network: ["name", "method", "address", "gateway", "dns", "route"],
  variable: ["name", "env", "default"],
};

// --- TOML Parser & Stringifier ---

function parseTOML(tomlText: string | null | undefined) {
  const result: { section: string, data: any }[] = [];
  if (!tomlText || typeof tomlText !== "string") return result;

  let currentObj: any = null;
  tomlText.split("\n").forEach(line => {
    line = line.trim();
    if (!line || line.startsWith("#")) return;

    if (line.startsWith("[[") && line.endsWith("]]")) {
      const section = line.slice(2, -2).trim();
      currentObj = {};
      result.push({ section, data: currentObj });
    } else if (line.includes("=")) {
      const [key, ...rest] = line.split("=");
      const valRaw = rest.join("=").trim();

      const parseVal = (v: string): any => {
        v = v.trim();
        if (v.startsWith('"')) return v.slice(1, -1);
        if (v === "true") return true;
        if (v === "false") return false;
        if (v.startsWith("[")) {
          const content = v.slice(1, -1).trim();
          if (!content) return [];
          return content.split(",").map(s => parseVal(s));
        }
        if (v.startsWith("{")) {
          const o: any = {};
          const content = v.slice(1, -1).trim();
          if (!content) return o;
          content.split(",").forEach(p => {
            const splitChar = p.includes(":") ? ":" : "=";
            const [pk, pv] = p.split(splitChar);
            if (pk && pv) o[pk.trim()] = parseVal(pv.trim());
          });
          return o;
        }
        return isNaN(Number(v)) ? v : Number(v);
      };

      if (currentObj) {
        const k = key.trim();
        const v = parseVal(valRaw);
        if (k.includes(".")) {
          const parts = k.split(".");
          let curr = currentObj;
          parts.forEach((p, i) => {
            if (i === parts.length - 1) curr[p] = v;
            else curr[p] = curr[p] || {};
            curr = curr[p];
          });
        } else currentObj[k] = v;
      }
    }
  });
  return result;
}

function stringifyTOML(items: { section: string, data: any }[] | null | undefined): string {
  let toml = "";
  if (!Array.isArray(items)) return toml;
  items.forEach(({ section, data }) => {
    toml += `[[${section}]]\n`;
    const writeObj = (obj: any, prefix = "") => {
      Object.entries(obj).forEach(([key, val]) => {
        if (val && typeof val === "object" && !Array.isArray(val)) {
          writeObj(val, `${prefix}${key}.`);
        } else if (val !== undefined) {
          let valStr = "";
          if (typeof val === "string") valStr = `"${val}"`;
          else if (Array.isArray(val)) {
            valStr = `[${val.map(v => typeof v === "string" ? `"${v}"` : JSON.stringify(v)).join(", ")}]`;
          } else valStr = JSON.stringify(val);
          toml += `${prefix}${key} = ${valStr}\n`;
        }
      });
    };
    writeObj(data);
    toml += "\n";
  });
  return toml.trim();
}

// --- Constants & Registry ---


const INITIAL_UNITS: Record<string, string> = {
  rind: `[[state]]
name = "active"
payload = "string"

[[state]]
name = "login_required"
payload = "none"
activate-on-none = ["rind@user_session"]

[[state]]
name = "user_session"
payload = "json"
branch = ["session_id"]

[[state]]
name = "user_auto_login"
payload = "json"
branch = ["tty"]

[[signal]]
name = "activate"
payload = "string"

[[signal]]
name = "deactivate"
payload = "string"

[[signal]]
name = "request_login"
payload = "json"

[[signal]]
name = "request_logout"
payload = "json"

[[state]]
name = "net-interface"
payload = "json"
branch = ["name"]

[[state]]
name = "online"
payload = "none"

[[state]]
name = "net-configured"
payload = "json"
branch = ["name"]

[[state]]
name = "net-dns_ready"
payload = "none"`,
  rind_mounting: `[[mount]]
source = "proc"
target = "/proc"
fstype = "proc"
create = true

[[mount]]
source = "sysfs"
target = "/sys"
fstype = "sysfs"
create = true

[[mount]]
source = "devtmpfs"
target = "/dev"
fstype = "devtmpfs"
create = true

[[mount]]
source = "tmpfs"
target = "/tmp"
fstype = "tmpfs"
create = true`,
  rind_networking: `[[network]]
name = "eth0"
method = "dhcp"`,
  rind_user: `
[[service]]
name = "user_login"
run.exec = "/usr/bin/user_login"
run.args = []
restart = false
start-on = [{ state = "rind@login_required" }]
transport = { id = "env", options = ["RIND_LOGIN_TTY=state:rind@login_required"] }

[[service]]
name = "user_shell"
run.exec = "/usr/bin/user_shell"
run.args = []
restart = true
start-on = [{ state = "rind@user_session" }]
transport = { id = "env", options = ["RIND_USER_ACTIVE=state:rind@user_session"] }`
};

const VALUE_TYPES: Record<string, any> = {
  unit: { name: "Unit", color: "#6366f1" },
  service: { name: "Service", color: "#3b82f6" },
  signal: { name: "Signal", color: "#ef4444" },
  state: { name: "State", color: "#10b981" },
  timer: { name: "Timer", color: "#f59e0b" },
  socket: { name: "Socket", color: "#8b5cf6" },
  network: { name: "Network", color: "#06b6d4" },
  variable: { name: "Variable", color: "#a855f7" },
  flowitem: { name: "FlowItem", color: "#bef264" },
  trigger: { name: "Trigger", color: "#fca5a5" },
  string: { name: "String", color: "#a1a1a1", inputType: "value", defaultValue: "" },
  boolean: { name: "Boolean", color: "#10b981", inputType: "value", defaultValue: false },
  number: { name: "Number", color: "#a1a1a1", inputType: "value", defaultValue: 0 },
};

// --- Component Templates ---

const TEMPLATES: Record<string, string> = {
  service: `
[[service]]
name = "new_service"
run = { exec = "/usr/bin/echo", args = ["hello"] }
start-on = []
restart = false`,
  state: `
[[state]]
name = "new_state"
payload = "json"`,
  signal: `
[[signal]]
name = "new_signal"
payload = "string"`,
  socket: `
[[socket]]
name = "new_socket"
type = "uds"
listen = "/tmp/new.sock"
lifecycle = "owned"`,
  timer: `
[[timer]]
name = "new_timer"
duration = "10s"`,
  mount: `
[[mount]]
source = "tmpfs"
target = "/mnt/new"
fstype = "tmpfs"
create = true`,
  network: `
[[network]]
name = "new_net"
method = "dhcp"`,
  variable: `
[[variable]]
name = "new_var"
default = "value"`,
};

// --- Sync Manager ---

const cleanNode = (n: any) => ({
  id: n.id,
  type: n.type,
  position: { x: Math.round(n.position?.x ?? 0), y: Math.round(n.position?.y ?? 0) },
  data: n.data
});

const isNodesEqual = (a: any[], b: any[]) => {
  if (a.length !== b.length) return false;
  return JSON.stringify(a.map(cleanNode)) === JSON.stringify(b.map(cleanNode));
};

const isEdgesEqual = (a: any[], b: any[]) => {
  if (a.length !== b.length) return false;
  const cleanEdge = (e: any) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle });
  return JSON.stringify(a.map(cleanEdge).sort((x, y) => x.id.localeCompare(y.id))) ===
    JSON.stringify(b.map(cleanEdge).sort((x, y) => x.id.localeCompare(y.id)));
};

const isDeepEqual = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

function SyncManager({
  appNodes,
  appEdges,
  onConnect,
  onEdgesDelete,
  onNodesDelete,
  onNodesChange
}: {
  appNodes: any[],
  appEdges: any[],
  onConnect: (params: any) => void,
  onEdgesDelete: (edges: any[]) => void,
  onNodesDelete: (nodes: any[]) => void,
  onNodesChange: (changes: any[]) => void
}) {
  const { setNodes, setEdges } = useReactFlow();
  const currentNodes = useNodes();
  const currentEdges = useEdges();

  const prevAppNodes = useRef(appNodes);
  const prevAppEdges = useRef(appEdges);
  const prevCurrentNodes = useRef(currentNodes);
  const prevCurrentEdges = useRef(currentEdges);

  // Inbound sync: App -> Graph
  useEffect(() => {
    if (!isNodesEqual(appNodes, currentNodes)) {
      setNodes(appNodes);
    }
    if (!isEdgesEqual(appEdges, currentEdges)) {
      setEdges(appEdges);
    }
    prevAppNodes.current = appNodes;
    prevAppEdges.current = appEdges;
  }, [appNodes, appEdges]);

  // Outbound sync: Graph -> App
  useEffect(() => {
    // Skip if current match app state (to avoid loops from inbound sync)
    // We compare with the known "official" nodes/edges from App
    if (isNodesEqual(currentNodes, prevAppNodes.current) && isEdgesEqual(currentEdges, prevAppEdges.current)) {
      prevCurrentNodes.current = currentNodes;
      prevCurrentEdges.current = currentEdges;
      return;
    }

    // Detect new edges (connections)
    if (currentEdges.length > prevCurrentEdges.current.length) {
      const newEdges = currentEdges.filter(e => !prevCurrentEdges.current.some(pe => pe.id === e.id));
      newEdges.forEach(newEdge => {
        // ONLY trigger for user-created edges (random IDs from React Flow)
        // System edges start with 'e-', 'e-t-', or 'owner-'
        const isSystemEdge = newEdge.id.startsWith("e-") || newEdge.id.startsWith("owner-");
        if (!isSystemEdge && newEdge.source && newEdge.target) {
          onConnect({
            source: newEdge.source,
            target: newEdge.target,
            targetHandle: newEdge.targetHandle
          });
        }
      });
    }
    // Detect deleted edges
    else if (currentEdges.length < prevCurrentEdges.current.length) {
      const deletedEdges = prevCurrentEdges.current.filter(pe => !currentEdges.some(e => e.id === pe.id));
      if (deletedEdges.length > 0) onEdgesDelete(deletedEdges);
    }
    // Detect deleted nodes
    else if (currentNodes.length < prevCurrentNodes.current.length) {
      const deletedNodes = prevCurrentNodes.current.filter(pn => !currentNodes.some(n => n.id === pn.id));
      if (deletedNodes.length > 0) onNodesDelete(deletedNodes);
    }
    // Detect data changes
    else {
      currentNodes.forEach((node) => {
        const prevNode = prevCurrentNodes.current.find(n => n.id === node.id);
        if (prevNode && !isDeepEqual(node.data, prevNode.data)) {
          onNodesChange([{ type: 'data', id: node.id, data: node.data }]);
        }
      });
    }

    prevCurrentNodes.current = currentNodes;
    prevCurrentEdges.current = currentEdges;
  }, [currentNodes, currentEdges]);

  return null;
}

// --- App ---

export default function App() {
  const graphRef = useRef<any>(null);
  const [selectedUnit, setSelectedUnit] = useState<string>("rind");
  const [unitTomls, setUnitTomls] = useState<Record<string, string>>(() => {
    const saved = localStorage.getItem("rind-units-store-v4");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        const clean: Record<string, string> = {};
        Object.entries(parsed).forEach(([k, v]) => {
          if (typeof v === "string") clean[k] = v;
        });
        return { ...INITIAL_UNITS, ...clean, rind: INITIAL_UNITS.rind };
      } catch (e) {
        console.error("Failed to parse saved units:", e);
      }
    }
    return INITIAL_UNITS;
  });

  const [newUnitName, setNewUnitName] = useState("");

  useEffect(() => {
    const toSave = { ...unitTomls };
    delete toSave.rind;
    localStorage.setItem("rind-units-store-v4", JSON.stringify(toSave));
  }, [unitTomls]);

  const unitsData = useMemo(() => {
    const data: Record<string, { section: string, data: any }[]> = {};
    Object.entries(unitTomls).forEach(([name, src]) => {
      data[name] = parseTOML(src);
    });
    return data;
  }, [unitTomls]);

  const handleAddUnit = () => {
    if (newUnitName && !unitTomls[newUnitName]) {
      setUnitTomls(prev => ({ ...prev, [newUnitName]: "" }));
      setSelectedUnit(newUnitName);
      setNewUnitName("");
    }
  };

  const handleAddComponent = (type: string) => {
    if (selectedUnit === "rind") return;
    setUnitTomls(prev => {
      const currentSrc = prev[selectedUnit] || "";
      const items = parseTOML(currentSrc);

      let name = `new_${type}`;
      let counter = 1;
      while (items.some(i => (i.data.name || i.data.target) === name)) {
        name = `new_${type}_${counter++}`;
      }

      let template = TEMPLATES[type].trim();
      template = template.replace(/name = ".*"/, `name = "${name}"`);
      template = template.replace(/target = ".*"/, `target = "${name}"`);

      return {
        ...prev,
        [selectedUnit]: currentSrc.trim() + "\n\n" + template + "\n"
      };
    });
  };

  const config = useBuildGraphConfig({
    valueTypes: VALUE_TYPES as any,
    nodeGroups: Object.entries(VALUE_TYPES).reduce((acc, [type, cfg]) => {
      acc[type] = { name: cfg.name, color: cfg.color };
      return acc;
    }, { unknown: { name: "Unknown", color: "#444444" } } as any),
    nodes: {
      unit: {
        name: "Unit",
        group: "unit",
        inputs: [{ name: "Name", id: "name", valueType: "string" }],
        outputs: [{ name: "Components", id: "components", valueType: "flowitem" }]
      },
      ...Object.entries(SCHEMAS).reduce((acc, [type, fields]) => {
        acc[type] = {
          name: type.charAt(0).toUpperCase() + type.slice(1),
          group: VALUE_TYPES[type] ? type : "unknown",
          inputs: [
            { name: "Unit", id: "unit-owner", valueType: "flowitem" },
            { name: "After", id: "after", valueType: "flowitem" },
            { name: "Trigger In", id: "trigger-in", valueType: "trigger" },
            ...fields.map(f => {
              const isConn = f.includes("on") || f.includes("source") || f === "after" || f === "activate-on-none" || f === "branching" || f === "restart" || f === "transport" || f === "trigger" || f === "finish";
              return {
                name: f.charAt(0).toUpperCase() + f.slice(1).replace("_", " "),
                id: f,
                valueType: isConn ? "flowitem" : "string"
              };
            })
          ],
          outputs: [
            { name: "Self", id: "flow", valueType: "flowitem" },
            ...fields.filter(f => f.startsWith("on") || f === "trigger" || f === "finish").map(f => ({ name: f, id: f, valueType: "trigger" }))
          ]
        };
        return acc;
      }, {} as any)
    },
  });

  const handleRemoveUnit = (unit: string) => {
    if (unit === "rind") return;
    if (window.confirm(`Are you sure you want to remove unit "${unit}"?`)) {
      setUnitTomls(prev => {
        const next = { ...prev };
        delete next[unit];
        return next;
      });
      if (selectedUnit === unit) setSelectedUnit("rind");
    }
  };

  const handleExportAll = () => {
    const blob = new Blob([JSON.stringify(unitTomls, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "rind-units-export.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCurrent = () => {
    const toml = unitTomls[selectedUnit];
    if (!toml) return;
    const blob = new Blob([toml], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedUnit}.toml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = ev.target?.result as string;
        if (file.name.endsWith(".json")) {
          try {
            const data = JSON.parse(text);
            const cleanData: Record<string, string> = {};
            Object.entries(data).forEach(([u, src]) => {
              if (!u.includes("@") && !u.startsWith("unit:") && typeof src === "string") {
                cleanData[u] = src;
              }
            });
            setUnitTomls(prev => ({ ...prev, ...cleanData }));
            const firstNew = Object.keys(cleanData)[0];
            if (firstNew) setSelectedUnit(firstNew);
          } catch (e) {
            console.error("Failed to parse JSON:", e);
          }
        } else if (file.name.endsWith(".toml")) {
          const unitName = file.name.replace(".toml", "");
          setUnitTomls(prev => ({ ...prev, [unitName]: text }));
          setSelectedUnit(unitName);
        }
      } catch (err) {
        alert("Failed to import file: " + err);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleReset = () => {
    if (window.confirm("Are you sure you want to reset ALL units to defaults? This will clear all your local changes.")) {
      localStorage.removeItem("rind-units-store-v4");
      setUnitTomls(INITIAL_UNITS);
      setSelectedUnit("else");
    }
  };

  const { nodes, edges } = useMemo(() => {
    const nodes: any[] = [];
    const edges: any[] = [];
    const nodeMap = new Map();

    Object.entries(unitsData).forEach(([unitName, items], unitIdx) => {
      const unitNodeId = `unit:${unitName}`;
      const unitNode = {
        id: unitNodeId,
        type: "unit",
        position: { x: unitIdx * 600, y: -200 },
        data: { label: unitName, name: unitName },
      };
      nodes.push(unitNode);
      nodeMap.set(unitNodeId, unitNode);

      let y = 0;
      items.forEach(({ section: sectionRaw, data: item }) => {
        const type = sectionRaw === "networking" ? "network" : sectionRaw;
        const name = item.name || item.target || "unnamed";
        const id = `${unitName}@${name}`;
        const node = {
          id, type,
          position: { x: unitIdx * 600, y: y * 250 },
          data: { ...item, label: id },
        };
        nodes.push(node);
        nodeMap.set(id, node);
        edges.push({ id: `owner-${unitName}-${id}`, source: unitNodeId, target: id, sourceHandle: "components", targetHandle: "unit-owner" });
        y++;
      });
    });

    const resolve = (current: string, ref: any) => {
      if (!ref || !current) return null;
      const target = typeof ref === "string" ? ref : (ref.state || ref.signal || ref.service || ref.timer || ref.socket || ref.target);
      if (!target || typeof target !== "string") return null;
      return target.includes("@") ? target : `${current}@${target}`;
    };

    nodes.forEach(node => {
      if (node.id.startsWith("unit:")) return;
      const [unit] = node.id.split("@");
      const item = node.data;
      const addEdge = (targetHandle: string, ref: any, sourceHandle: string = "flow") => {
        const sId = resolve(unit, ref);
        if (sId && nodeMap.has(sId)) {
          edges.push({ id: `e-${sId}-${node.id}-${targetHandle}`, source: sId, target: node.id, sourceHandle, targetHandle });
        }
      };
      ["after", "start-on", "stop-on", "owner", "user-source", "branching", "activate-on-none"].forEach(k => {
        const val = item[k] || item[k.replace("_", "-")];
        if (val) (Array.isArray(val) ? val : [val]).forEach(v => addEdge(k, v));
      });
      ["on-start", "on-stop", "trigger", "finish"].forEach(k => {
        const val = item[k] || item[k.replace("_", "-")];
        if (val) (Array.isArray(val) ? val : [val]).forEach((v, i) => {
          const tId = resolve(unit, v);
          if (tId && nodeMap.has(tId)) edges.push({ id: `e-t-${node.id}-${tId}-${k}-${i}`, source: node.id, target: tId, sourceHandle: k, targetHandle: "trigger-in" });
        });
      });
    });

    return { nodes, edges };
  }, [unitsData]);

  const onConnect = useCallback((params: any) => {
    const { source, target, targetHandle } = params;
    if (!target || !targetHandle || target.startsWith("unit:") || !target.includes("@")) return;
    const [targetUnit, targetName] = target.split("@");
    if (!targetUnit || !targetName) return;

    setUnitTomls(prev => {
      if (!prev[targetUnit]) return prev;
      const items = parseTOML(prev[targetUnit]);
      const entry = items.find(i => (i.data.name || i.data.target) === targetName);
      if (entry) {
        const item = entry.data;
        const val = source.includes("@") ? source : source.replace("unit:", "");
        if (Array.isArray(item[targetHandle])) {
          if (!item[targetHandle].includes(val)) item[targetHandle].push(val);
        } else if (item[targetHandle]) {
          if (item[targetHandle] !== val) {
            item[targetHandle] = [item[targetHandle], val];
          }
        } else {
          item[targetHandle] = val;
        }
        return { ...prev, [targetUnit]: stringifyTOML(items) };
      }
      return prev;
    });
  }, []);

  const onEdgesDelete = useCallback((deletedEdges: any[]) => {
    deletedEdges.forEach(edge => {
      const { target, targetHandle, source } = edge;
      if (!target || !targetHandle || target.startsWith("unit:") || !target.includes("@")) return;
      const [targetUnit, targetName] = target.split("@");
      if (!targetUnit || !targetName) return;

      setUnitTomls(prev => {
        if (!prev[targetUnit]) return prev;
        const items = parseTOML(prev[targetUnit]);
        const entry = items.find(i => (i.data.name || i.data.target) === targetName);
        if (entry) {
          const item = entry.data;
          const val = source.includes("@") ? source : source.replace("unit:", "");
          if (Array.isArray(item[targetHandle])) {
            item[targetHandle] = item[targetHandle].filter((v: any) => v !== val);
          } else if (item[targetHandle] === val) {
            delete item[targetHandle];
          }
          return { ...prev, [targetUnit]: stringifyTOML(items) };
        }
        return prev;
      });
    });
  }, []);

  const onNodesDelete = useCallback((deletedNodes: any[]) => {
    setUnitTomls(prev => {
      const next = { ...prev };
      deletedNodes.forEach(node => {
        if (node.id.startsWith("unit:")) {
          const unitName = node.id.replace("unit:", "");
          delete next[unitName];
          return;
        }
        if (!node.id.includes("@")) return;
        const [unit, name] = node.id.split("@");
        if (!unit || !name || !next[unit]) return;
        const items = parseTOML(next[unit]);
        const filtered = items.filter(i => (i.data.name || i.data.target) !== name);
        next[unit] = stringifyTOML(filtered);
      });
      return next;
    });
  }, []);

  const onNodesChange = useCallback((changes: any[]) => {
    changes.forEach(change => {
      if (change.type === 'data') {
        const { id, data } = change;
        if (!id) return;

        if (id.startsWith("unit:")) {
          const oldName = id.replace("unit:", "");
          const newName = data.name;
          if (newName && newName !== oldName) {
            setUnitTomls(prev => {
              if (!prev[oldName]) return prev;
              const next = { ...prev };
              next[newName] = next[oldName];
              delete next[oldName];
              return next;
            });
            setSelectedUnit(newName);
          }
          return;
        }

        if (!id.includes("@")) return;
        const [unitName, componentName] = id.split("@");
        if (!unitName || !componentName) return;
        setUnitTomls(prev => {
          if (!prev[unitName]) return prev;
          const items = parseTOML(prev[unitName]);
          const entry = items.find(i => (i.data.name || i.data.target) === componentName);
          if (entry) {
            Object.assign(entry.data, data);
            return { ...prev, [unitName]: stringifyTOML(items) };
          }
          return prev;
        });
      }
    });
  }, []);

  return (
    <div className="app-container">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-title">
            Units Management
            <span style={{ fontSize: "10px", color: "#444" }}>v4.0</span>
          </div>
          <div className="unit-input-group">
            <input
              className="unit-input"
              value={newUnitName}
              onChange={e => setNewUnitName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
              placeholder="new_unit_name"
              onKeyDown={e => e.key === "Enter" && handleAddUnit()}
            />
            <button className="btn-add" onClick={handleAddUnit}>+</button>
          </div>
          <div className="unit-tabs">
            {Object.keys(unitTomls).sort().map(u => (
              <div
                key={u}
                className={`unit-tab ${selectedUnit === u ? "active" : ""}`}
              >
                <span onClick={() => setSelectedUnit(u)} style={{ flex: 1 }}>
                  {u}{u === "rind" ? " (core)" : ""}
                </span>
                {u !== "rind" && (
                  <button className="btn-remove" onClick={(e) => { e.stopPropagation(); handleRemoveUnit(u); }}>×</button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="unit-actions">
          <button className="btn-action" onClick={handleExportAll}>Export All</button>
          <button className="btn-action" onClick={handleExportCurrent}>Export Current</button>
          <button className="btn-action" onClick={() => graphRef.current?.layout()}>Layout Graph</button>
          <label className="btn-action">
            Import
            <input type="file" style={{ display: "none" }} accept=".toml,.json" onChange={handleImport} />
          </label>
          <button className="btn-action" style={{ background: "#442222" }} onClick={handleReset}>Reset Defaults</button>
        </div>

        <div className="editor-container">
          <div className="editor-toolbar">
            <span className="editor-label">{selectedUnit}.toml</span>
            {selectedUnit !== "rind" && (
              <select
                className="template-select"
                onChange={(e) => {
                  handleAddComponent(e.target.value);
                  e.target.value = "";
                }}
                value=""
              >
                <option value="" disabled>+ Add Component</option>
                {Object.keys(TEMPLATES).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
          </div>
          <textarea
            className="toml-textarea"
            value={unitTomls[selectedUnit]}
            onChange={e => selectedUnit !== "rind" && setUnitTomls(prev => ({ ...prev, [selectedUnit]: e.target.value }))}
            readOnly={selectedUnit === "rind"}
            spellCheck={false}
          />
        </div>
      </aside>

      <main className="main-content">
        <ReactFlowProvider>
          <GraphConfigProvider defaultConfig={config}>
            <NodeGraphEditor
              ref={graphRef}
              defaultNodes={nodes}
              defaultEdges={edges}
            >
              <SyncManager
                appNodes={nodes}
                appEdges={edges}
                onConnect={onConnect}
                onEdgesDelete={onEdgesDelete}
                onNodesDelete={onNodesDelete}
                onNodesChange={onNodesChange}
              />
              <Background color="#111" variant={BackgroundVariant.Lines} />
            </NodeGraphEditor>
          </GraphConfigProvider>
        </ReactFlowProvider>
      </main>
    </div>
  );
}


