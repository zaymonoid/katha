import { formatDistanceToNow } from "date-fns";
import { html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { QueriesAction, QueriesState, QueryState, QueryStatus } from "./query.ts";
import type { StoreHandle } from "./types.ts";

type Store = StoreHandle<{ queries: QueriesState }, QueriesAction>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

interface ParsedKey {
  name: string;
  suffix: string;
}

function parseQueryKey(key: string): ParsedKey {
  const colonIdx = key.indexOf(":");
  return colonIdx === -1
    ? { name: key, suffix: "" }
    : { name: key.slice(0, colonIdx), suffix: key.slice(colonIdx + 1) };
}

function worstStatus(statuses: Iterable<QueryStatus>): QueryStatus {
  let result: QueryStatus = "success";
  for (const s of statuses) {
    if (s === "error") return "error";
    if (s === "loading") result = "loading";
  }
  return result;
}

interface QueryGroup {
  name: string;
  entries: Array<{ key: string; suffix: string; state: QueryState<unknown> }>;
  aggregateStatus: QueryStatus;
}

function groupQueries(cache: Record<string, QueryState<unknown>>): QueryGroup[] {
  const groups = new Map<string, QueryGroup["entries"]>();
  for (const [key, qs] of Object.entries(cache)) {
    const { name, suffix } = parseQueryKey(key);
    let group = groups.get(name);
    if (!group) {
      group = [];
      groups.set(name, group);
    }
    group.push({ key, suffix, state: qs });
  }
  const result: QueryGroup[] = [];
  for (const [name, entries] of groups) {
    const aggregateStatus = worstStatus(entries.map((e) => e.state.status));
    result.push({ name, entries, aggregateStatus });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

const STATUS_STYLES = {
  success: {
    dot: "bg-emerald-500",
    ring: "ring-emerald-500/50",
    pill: "bg-emerald-500/20 text-emerald-400",
  },
  loading: {
    dot: "bg-yellow-500",
    ring: "ring-yellow-500/50",
    pill: "bg-yellow-500/20 text-yellow-400",
  },
  error: { dot: "bg-red-500", ring: "ring-red-500/50", pill: "bg-red-500/20 text-red-400" },
} as const;

function relativeTime(ts: number | undefined): string {
  if (ts === undefined) return "—";
  return formatDistanceToNow(ts, { addSuffix: true });
}

function absoluteTime(ts: number | undefined): string {
  if (ts === undefined) return "";
  return new Date(ts).toLocaleString();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class QueryDevtools extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  accessor store: Store | undefined;

  @state()
  private accessor _open = false;

  @state()
  private accessor _selectedKey: string | null = null;

  @state()
  private accessor _expandedGroups: Set<string> = new Set();

  @state()
  private accessor _cache: Record<string, QueryState<unknown>> = {};

  private _unsubscribe: (() => void) | undefined;
  private _refreshInterval: ReturnType<typeof setInterval> | undefined;

  connectedCallback() {
    super.connectedCallback();
    this._subscribeToStore();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanup();
  }

  updated(changed: PropertyValues<this>) {
    if (changed.has("store")) {
      this._cleanup();
      this._subscribeToStore();
    }
  }

  private _subscribeToStore() {
    if (!this.store) return;
    this._unsubscribe = this.store.subscribe((s) => {
      this._cache = s.queries.cache;
      if (this._selectedKey && !this._cache[this._selectedKey]) {
        this._selectedKey = null;
      }
    });
    this._cache = this.store.getState().queries.cache;
  }

  private _cleanup() {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    this._stopRefresh();
  }

  private _startRefresh() {
    if (this._refreshInterval) return;
    this._refreshInterval = setInterval(() => {
      this.requestUpdate();
    }, 1000);
  }

  private _stopRefresh() {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = undefined;
    }
  }

  private _togglePanel() {
    this._open = !this._open;
    if (this._open) {
      this._startRefresh();
    } else {
      this._stopRefresh();
    }
  }

  private _toggleGroup(name: string) {
    const next = new Set(this._expandedGroups);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    this._expandedGroups = next;
  }

  private _selectKey(key: string) {
    this._selectedKey = key;
  }

  private _invalidateGroup(name: string) {
    this.store?.put({ id: "query-invalidate", data: { queryName: name } });
  }

  render() {
    const count = Object.keys(this._cache).length;
    const status =
      count > 0 ? worstStatus(Object.values(this._cache).map((q) => q.status)) : "success";

    return html`
      ${this._renderTrigger(count, status)}
      ${this._open ? this._renderPanel() : nothing}
    `;
  }

  private _renderTrigger(count: number, status: QueryStatus) {
    return html`
      <button
        @click=${this._togglePanel}
        class="fixed bottom-4 right-4 z-50 w-10 h-10 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center shadow-lg ring-2 ${STATUS_STYLES[status].ring} hover:bg-zinc-700 transition-colors cursor-pointer"
        title="Query Devtools"
        aria-label="Toggle query devtools panel"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-zinc-300">
          <ellipse cx="12" cy="12" rx="10" ry="4"/>
          <path d="M2 12v4c0 2.2 4.5 4 10 4s10-1.8 10-4v-4"/>
          <path d="M2 8v4c0 2.2 4.5 4 10 4s10-1.8 10-4V8"/>
          <ellipse cx="12" cy="8" rx="10" ry="4"/>
        </svg>
        ${count > 0 ? html`<span class="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-zinc-600 text-[10px] font-bold text-zinc-200 px-1">${count}</span>` : nothing}
      </button>
    `;
  }

  private _renderPanel() {
    const groups = groupQueries(this._cache);
    const selectedEntry = this._selectedKey ? this._cache[this._selectedKey] : undefined;

    return html`
      <div class="fixed bottom-0 left-0 right-0 z-40 h-[40vh] bg-zinc-900 border-t border-zinc-700 flex flex-col text-sm font-mono">
        <!-- Header -->
        <div class="flex items-center justify-between px-4 py-2 border-b border-zinc-700 shrink-0">
          <div class="flex items-center gap-2">
            <span class="text-zinc-200 font-semibold text-xs uppercase tracking-wider">Query Cache</span>
            <span class="text-zinc-500 text-xs">(${Object.keys(this._cache).length})</span>
          </div>
          <button @click=${this._togglePanel} class="text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer text-lg leading-none" aria-label="Close devtools panel">&times;</button>
        </div>

        <!-- Body -->
        <div class="flex flex-1 overflow-hidden">
          <!-- Query list -->
          <div class="w-[40%] border-r border-zinc-700 overflow-y-auto">
            ${
              groups.length === 0
                ? html`<div class="p-4 text-zinc-500 text-xs">No queries in cache</div>`
                : repeat(
                    groups,
                    (g) => g.name,
                    (g) => this._renderGroup(g),
                  )
            }
          </div>

          <!-- Detail -->
          <div class="w-[60%] overflow-y-auto p-4">
            ${
              selectedEntry && this._selectedKey
                ? this._renderDetail(this._selectedKey, selectedEntry)
                : html`<div class="text-zinc-500 text-xs">Select a query to inspect</div>`
            }
          </div>
        </div>
      </div>
    `;
  }

  private _renderGroup(group: QueryGroup) {
    const expanded = this._expandedGroups.has(group.name);

    return html`
      <div class="border-b border-zinc-800">
        <button
          @click=${() => this._toggleGroup(group.name)}
          class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-800 transition-colors cursor-pointer text-left"
        >
          <span class="text-zinc-500 text-[10px]">${expanded ? "▼" : "▶"}</span>
          <span class="w-2 h-2 rounded-full shrink-0 ${STATUS_STYLES[group.aggregateStatus].dot}"></span>
          <span class="text-zinc-300 text-xs truncate">${group.name}</span>
          <span class="text-zinc-600 text-[10px] ml-auto">${group.entries.length}</span>
        </button>
        ${
          expanded
            ? html`
            <div class="pl-4">
              ${repeat(
                group.entries,
                (e) => e.key,
                (e) => html`
                  <button
                    @click=${() => this._selectKey(e.key)}
                    class="w-full flex items-center gap-2 px-3 py-1 hover:bg-zinc-800/50 transition-colors cursor-pointer text-left ${this._selectedKey === e.key ? "bg-zinc-800" : ""}"
                  >
                    <span class="text-zinc-400 text-xs truncate flex-1">${e.suffix || "(root)"}</span>
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_STYLES[e.state.status].pill}">${e.state.status}</span>
                    ${e.state.isFetching ? html`<span class="text-[10px] text-yellow-400 animate-pulse">⟳</span>` : nothing}
                    <span class="text-zinc-600 text-[10px] shrink-0">${relativeTime(e.state.dataUpdatedAt)}</span>
                  </button>
                `,
              )}
            </div>
          `
            : nothing
        }
      </div>
    `;
  }

  private _renderDetail(key: string, qs: QueryState<unknown>) {
    const { name: groupName } = parseQueryKey(key);

    return html`
      <div class="flex flex-col gap-3">
        <div class="flex items-start justify-between">
          <div>
            <div class="text-zinc-200 text-xs font-semibold break-all">${key}</div>
            <div class="flex items-center gap-2 mt-1">
              <span class="px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_STYLES[qs.status].pill}">${qs.status}</span>
              ${qs.isFetching ? html`<span class="text-[10px] text-yellow-400 animate-pulse">fetching</span>` : nothing}
            </div>
          </div>
          <button
            @click=${() => this._invalidateGroup(groupName)}
            class="px-2 py-1 text-[10px] font-medium rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors cursor-pointer shrink-0"
          >Invalidate</button>
        </div>

        <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <span class="text-zinc-500">Updated</span>
          <span class="text-zinc-300">${relativeTime(qs.dataUpdatedAt)}${qs.dataUpdatedAt ? html` <span class="text-zinc-600">(${absoluteTime(qs.dataUpdatedAt)})</span>` : nothing}</span>

          ${
            qs.error
              ? html`
              <span class="text-zinc-500">Error</span>
              <span class="text-red-400 break-all">${qs.error}</span>
            `
              : nothing
          }
        </div>

        <div>
          <div class="text-zinc-500 text-[10px] uppercase tracking-wider mb-1">Data</div>
          <pre class="bg-zinc-950 rounded p-3 text-xs text-zinc-300 overflow-auto max-h-[20vh] whitespace-pre-wrap break-all">${qs.data !== undefined ? JSON.stringify(qs.data, null, 2) : "undefined"}</pre>
        </div>
      </div>
    `;
  }
}

customElements.define("query-devtools", QueryDevtools);
