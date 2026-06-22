import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "../types";
import { cloudStorage, saveToCloud } from "@/services/api/cloud-storage";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects">;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
let cloudSaveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingCloudProjects: CanvasProject[] | null = null;

function scheduleCloudSave(projects: CanvasProject[]) {
    pendingCloudProjects = projects;
    if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
    cloudSaveTimer = setTimeout(() => {
        cloudSaveTimer = null;
        const toSave = pendingCloudProjects;
        pendingCloudProjects = null;
        if (toSave?.length) saveToCloud(() => cloudStorage.batchSaveProjects(toSave));
    }, 1500);
}

function mergeProjects(local: CanvasProject[], remote: CanvasProject[]): CanvasProject[] {
    const map = new Map(local.map((p) => [p.id, p]));
    for (const r of remote) {
        const l = map.get(r.id);
        if (!l || new Date(r.updatedAt).getTime() >= new Date(l.updatedAt).getTime()) map.set(r.id, r);
    }
    return Array.from(map.values()).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

async function mergeWithCloud() {
    try {
        const { projects: remoteList } = await cloudStorage.listProjects();
        if (!remoteList?.length) return;
        const localProjects = useCanvasStore.getState().projects;
        const localMap = new Map(localProjects.map((p) => [p.id, p]));
        const toFetch = remoteList.filter((r) => {
            const l = localMap.get(r.id);
            return !l || new Date(r.updatedAt).getTime() > new Date(l.updatedAt).getTime();
        });
        if (!toFetch.length) return;
        const fetched = (
            await Promise.all(toFetch.map((r) => cloudStorage.getProject(r.id).then((res) => res.project as CanvasProject).catch(() => null)))
        ).filter(Boolean) as CanvasProject[];
        if (!fetched.length) return;
        const merged = mergeProjects(localProjects, fetched);
        useCanvasStore.getState().replaceProjects(merged);
    } catch {
        // fail silently — cloud sync is best-effort
    }
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
        queuedPersistState = parsed.state as PersistedCanvasState;
        return parsed;
    },
    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects) return;
        queuedPersistState = nextState;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void localForageStorage.setItem(name, JSON.stringify(value));
        }, 400);
        scheduleCloudSave(nextState.projects);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            createProject: (title = "未命名画布") => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || "导入画布",
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => get().projects.find((item) => item.id === id) || null,
            renameProject: (id, title) =>
                set((state) => ({
                    projects: state.projects.map((p) => (p.id === id ? { ...p, title: title.trim() || p.title, updatedAt: new Date().toISOString() } : p)),
                })),
            deleteProjects: (ids) => {
                ids.forEach((id) => saveToCloud(() => cloudStorage.deleteProject(id)));
                set((state) => ({ projects: state.projects.filter((p) => !ids.includes(p.id)) }));
            },
            replaceProjects: (projects) => set({ projects }),
            updateProject: (id, patch) =>
                set((state) => ({
                    projects: state.projects.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p)),
                })),
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) => ({ projects: state.projects }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: true });
                void mergeWithCloud();
            },
        },
    ),
);
