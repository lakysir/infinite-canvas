import { useConfigStore } from "@/stores/use-config-store";

const BASE_URL = "https://www.aimh8.com/agent/openapi/fpbrowser2api";

async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const apiKey = useConfigStore.getState().config.mirrmartApiKey.trim();
    if (!apiKey) throw new Error("mirrmartApiKey not set");
    const resp = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!resp.ok) throw new Error(`cloud API ${resp.status}`);
    return resp.json() as T;
}

export type CloudProject = { id: string; title: string; updatedAt: string; createdAt: string };

export const cloudStorage = {
    listProjects: () => request<{ projects: CloudProject[] }>("GET", "/v1/canvas/projects"),
    getProject: (id: string) => request<{ project: unknown }>("GET", `/v1/canvas/projects/${encodeURIComponent(id)}`),
    saveProject: (project: unknown) => request("POST", "/v1/canvas/projects", project),
    updateProject: (id: string, patch: unknown) => request("PUT", `/v1/canvas/projects/${encodeURIComponent(id)}`, patch),
    deleteProject: (id: string) => request("DELETE", `/v1/canvas/projects/${encodeURIComponent(id)}`),
    batchSaveProjects: (projects: unknown[]) => request("POST", "/v1/canvas/projects/batch", { projects }),

    getLogs: (type: "image" | "video", page = 1, pageSize = 50) =>
        request<{ logs: unknown[] }>("GET", `/v1/workbench/logs?type=${type}&page=${page}&pageSize=${pageSize}`),
    saveLogs: (type: "image" | "video", logs: unknown[]) => request("POST", "/v1/workbench/logs", { type, logs }),
    deleteLog: (id: string) => request("DELETE", `/v1/workbench/logs/${encodeURIComponent(id)}`),

    getAssets: () => request<{ assets: unknown[] }>("GET", "/v1/assets"),
    batchSaveAssets: (assets: unknown[]) => request("POST", "/v1/assets/batch", { assets }),
    deleteAsset: (id: string) => request("DELETE", `/v1/assets/${encodeURIComponent(id)}`),

    getConfig: () => request<{ config: unknown }>("GET", "/v1/user/config"),
    saveConfig: (config: unknown) => request("PUT", "/v1/user/config", config),
};

/** Fire-and-forget cloud save — never throws. */
export function saveToCloud(fn: () => Promise<unknown>): void {
    void fn().catch(() => undefined);
}
