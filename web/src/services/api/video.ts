import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { uploadReferenceMedia } from "@/services/api/media-upload";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { buildApiUrl, modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = {
    id?: string;
    task_id?: string;
    status?: string;
    error?: { message?: string } | string | null;
    video_url?: string;
    url?: string;
    output?: string | string[] | { url?: string; video_url?: string } | Array<{ url?: string; video_url?: string }>;
    result?: string | string[] | { url?: string; video_url?: string; result_url?: string; result_urls?: string[] } | Array<{ url?: string; video_url?: string }>;
    metadata?: { video_url?: string; result_url?: string; result_urls?: string[]; url?: string };
};
type ApiVideoResponse = VideoResponse | { code?: number; data?: VideoResponse | null; msg?: string };
type SeedanceTask = {
    id: string;
    status?: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; last_frame_url?: string } | null;
};
type ApiEnvelope<T> = T | { code?: number; data?: T | null; msg?: string };
type RequestOptions = { signal?: AbortSignal };

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "seedance" | "newtoken"; model: string };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

const NEWTOKEN_VIDEO_MODELS = new Set(["video-fast-480p", "video-pro-480p", "video-fast-720p", "video-pro-720p", "video-pro-1080p", "veo-3-1", "veo-omni-flash", "veo-omni-flash-video-edit"]);
const NEWTOKEN_FIXED_SECONDS: Record<string, number> = {
    "veo-3-1": 8,
    "veo-omni-flash": 10,
    "veo-omni-flash-video-edit": 10,
};

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    const task = await createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, options);
    const delayMs = task.provider === "seedance" || task.provider === "newtoken" ? 5000 : 2500;
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        if (attempt === 119) throw new Error(`${task.provider === "seedance" ? "Seedance " : task.provider === "newtoken" ? "NewToken " : ""}video generation timed out`);
        await delay(delayMs, options?.signal);
    }
    throw new Error("Video generation timed out");
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (isSeedanceVideoConfig(requestConfig)) {
        return createSeedanceTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
    }
    if (isNewTokenVideoModel(requestConfig.model)) {
        return createNewTokenVideoTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
    }
    if (videoReferences.length || audioReferences.length) {
        throw new Error("This video API does not support reference video or audio. Use Seedance/Ark Plan or remove those references.");
    }
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "seedance") return pollSeedanceTask(requestConfig, task, options);
    if (task.provider === "newtoken") return pollNewTokenVideoTask(requestConfig, task, options);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) return uploadMediaFile(result.blob, "video");
    if (result.url) return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
    throw new Error("Video API did not return a playable video");
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const imageUrls = await Promise.all(references.slice(0, 7).map((image) => resolveUploadedImageUrl(config, image)));
    const body = {
        model: modelOptionName(model),
        prompt,
        seconds: normalizeVideoSeconds(config.videoSeconds),
        ...(normalizeVideoSize(config.size) ? { size: normalizeVideoSize(config.size) } : {}),
        resolution_name: normalizeVideoResolution(config.vquality),
        preset: "normal",
        ...(imageUrls.length ? { input_reference: imageUrls } : {}),
    };
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        if (!created.id) throw new Error("Video task id is missing");
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "Video task creation failed"));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        if (video.status === "completed") {
            const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: readVideoError(video.error) || "Video generation failed" };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, "Video task query failed"));
    }
}

async function createNewTokenVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model);
    const payload = await buildNewTokenVideoPayload(config, modelName, prompt, references, videoReferences, audioReferences);
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        const id = created.id || created.task_id;
        if (!id) throw new Error("NewToken video task id is missing");
        return { id, provider: "newtoken", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "NewToken video task creation failed"));
    }
}

async function pollNewTokenVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const status = (video.status || "").toLowerCase();
        const videoUrl = extractVideoUrl(video);
        if (videoUrl) return { status: "completed", result: await videoResultFromUrl(videoUrl, options) };
        if (["completed", "succeeded", "success", "done"].includes(status)) return { status: "failed", error: "NewToken task completed without video_url" };
        if (["failed", "cancelled", "canceled", "expired", "error"].includes(status)) return { status: "failed", error: readVideoError(video.error) || "NewToken video generation failed" };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, "NewToken video task query failed"));
    }
}

async function createSeedanceTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (audioReferences.length && !references.length && !videoReferences.length) {
        throw new Error("Seedance audio references require at least one image or video reference");
    }
    assertSeedanceVideoReferences(videoReferences);
    assertSeedanceAudioReferences(audioReferences);
    const content = await buildSeedanceContent(config, prompt, references, videoReferences, audioReferences);
    if (!content.length) throw new Error("Please enter a video prompt or connect reference media");
    const payload = {
        model: modelOptionName(model),
        content,
        ratio: normalizeSeedanceRatio(config.size),
        resolution: normalizeSeedanceResolution(config.vquality, modelOptionName(model)),
        duration: normalizeSeedanceDuration(config.videoSeconds),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
    };

    try {
        const created = unwrapSeedanceTask((await axios.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        if (!created.id) throw new Error("Seedance task id is missing");
        return { id: created.id, provider: "seedance", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "Seedance task creation failed"));
    }
}

async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapSeedanceTask((await axios.get<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config, task.id), { headers: aiHeaders(config), signal: options?.signal })).data);
        if (state.status === "succeeded") {
            const url = state.content?.video_url;
            if (!url) return { status: "failed", error: "Seedance task succeeded without video_url" };
            return { status: "completed", result: await videoResultFromUrl(url, options) };
        }
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired") return { status: "failed", error: state.error?.message || `Seedance video generation ${state.status}` };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, "Seedance task query failed"));
    }
}

function assertSeedanceVideoReferences(videoReferences: ReferenceVideo[]) {
    const error = seedanceVideoReferenceError(videoReferences);
    if (error) throw new Error(error);
    let total = 0;
    for (const video of videoReferences) {
        if (!video.durationMs) continue;
        if (video.durationMs < 2000 || video.durationMs > 15000) throw new Error("Seedance reference videos must be 2-15 seconds each");
        total += video.durationMs;
    }
    if (total > 15000) throw new Error("Seedance reference videos cannot exceed 15 seconds in total");
}

function assertSeedanceAudioReferences(audioReferences: ReferenceAudio[]) {
    let total = 0;
    for (const audio of audioReferences) {
        if (!audio.durationMs) continue;
        if (audio.durationMs < 2000 || audio.durationMs > 15000) throw new Error("Seedance reference audio must be 2-15 seconds each");
        total += audio.durationMs;
    }
    if (total > 15000) throw new Error("Seedance reference audio cannot exceed 15 seconds in total");
}

function seedanceApiUrl(config: AiConfig, taskId?: string) {
    return buildApiUrl(config.baseUrl, `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`);
}

async function buildSeedanceContent(config: AiConfig, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[]) {
    const content: Array<Record<string, unknown>> = [];
    const text = buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
    if (text) content.push({ type: "text", text });
    for (const image of references.slice(0, SEEDANCE_REFERENCE_LIMITS.images)) {
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(config, image) }, role: "reference_image" });
    }
    for (const video of videoReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.videos)) {
        content.push({ type: "video_url", video_url: { url: await resolveSeedanceVideoUrl(config, video) }, role: "reference_video" });
    }
    for (const audio of audioReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.audios)) {
        content.push({ type: "audio_url", audio_url: { url: await resolveSeedanceAudioUrl(audio) }, role: "reference_audio" });
    }
    return content;
}

async function resolveSeedanceImageUrl(config: AiConfig, image: ReferenceImage) {
    return resolveUploadedImageUrl(config, image);
}

async function resolveUploadedImageUrl(config: AiConfig, image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("asset://")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error("Failed to read reference image");
    return uploadReferenceMedia(config, dataUrlToFile({ ...image, dataUrl }), "image", image.name || "reference.png");
}

async function resolveSeedanceVideoUrl(config: AiConfig, video: ReferenceVideo) {
    if (isPublicMediaUrl(video.url) || video.url.startsWith("asset://")) return video.url;
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new Error("Reference video must be a public URL, asset id, or locally stored video");
    return uploadReferenceMedia(config, blob, "video", video.name || "reference.mp4");
}

async function resolveSeedanceAudioUrl(audio: ReferenceAudio) {
    if (isPublicMediaUrl(audio.url) || audio.url.startsWith("asset://")) return audio.url;
    let blob: Blob | null = null;
    if (audio.storageKey) blob = await getMediaBlob(audio.storageKey);
    if (!blob && audio.url?.startsWith("blob:")) blob = await (await fetch(audio.url)).blob();
    if (!blob) throw new Error("Reference audio must be a public URL, asset id, or locally stored audio");
    return blobToDataUrl(blob);
}

async function videoResultFromUrl(url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(url, { responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        return { url, mimeType: "video/mp4" };
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("Please configure a video model first");
    if (!config.baseUrl.trim()) throw new Error("Please configure Base URL first");
    if (!config.apiKey.trim()) throw new Error("Please configure API Key first");
    if (config.apiFormat === "gemini") throw new Error("Gemini format does not support video generation. Use an OpenAI-compatible channel.");
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function isNewTokenVideoModel(model: string) {
    return NEWTOKEN_VIDEO_MODELS.has(modelOptionName(model).trim().toLowerCase());
}

async function buildNewTokenVideoPayload(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[]) {
    const modelName = modelOptionName(model).trim();
    const normalizedModelName = modelName.toLowerCase();
    const payload: Record<string, unknown> = {
        model: modelName,
        prompt,
        duration: normalizeNewTokenSeconds(modelName, config.videoSeconds),
    };
    const aspectRatio = normalizeNewTokenAspectRatio(config.size);
    if (aspectRatio) payload.aspect_ratio = aspectRatio;
    const imageUrls = await Promise.all(references.slice(0, 7).map((image) => resolveNewTokenImageUrl(config, image)));
    if (imageUrls.length) {
        if (normalizedModelName === "veo-omni-flash-video-edit") {
            payload.Ingredients_images = imageUrls;
        } else if (normalizedModelName.startsWith("veo-")) {
            payload.images = imageUrls;
        } else {
            payload.extra_images = imageUrls;
        }
    }
    const videoUrls = await Promise.all(videoReferences.map((video) => resolveNewTokenVideoUrl(config, video)));
    if (videoUrls.length) payload.extra_videos = videoUrls;
    const audioUrls = await Promise.all(audioReferences.map((audio) => resolveNewTokenAudioUrl(audio)));
    if (audioUrls.length) payload.extra_audios = audioUrls;
    return payload;
}

function normalizeNewTokenSeconds(model: string, value: string) {
    const modelName = modelOptionName(model).trim().toLowerCase();
    const fixed = NEWTOKEN_FIXED_SECONDS[modelName];
    if (fixed) return fixed;
    const seconds = Math.floor(Number(value) || 6);
    return Math.max(4, Math.min(15, seconds));
}

function normalizeNewTokenAspectRatio(value: string) {
    const size = value.trim();
    if (!size || size === "auto") return undefined;
    const dimensions = size.match(/^(\d+)x(\d+)$/i);
    if (dimensions) {
        const width = Number(dimensions[1]);
        const height = Number(dimensions[2]);
        if (!width || !height) return undefined;
        return width >= height ? "16:9" : "9:16";
    }
    return /^\d+:\d+$/.test(size) ? size : undefined;
}

async function resolveNewTokenImageUrl(config: AiConfig, image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("asset://")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    return uploadReferenceMedia(config, dataUrlToFile({ ...image, dataUrl }), "image", image.name || "reference.png");
}

async function resolveNewTokenVideoUrl(config: AiConfig, video: ReferenceVideo) {
    if (isPublicMediaUrl(video.url) || video.url.startsWith("asset://")) return video.url;
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new Error("NewToken video reference must be a public URL or local stored video");
    return uploadReferenceMedia(config, blob, "video", video.name || "reference.mp4");
}

async function resolveNewTokenAudioUrl(audio: ReferenceAudio) {
    if (isPublicMediaUrl(audio.url) || audio.url.startsWith("data:audio/") || audio.url.startsWith("asset://")) return audio.url;
    let blob: Blob | null = null;
    if (audio.storageKey) blob = await getMediaBlob(audio.storageKey);
    if (!blob && audio.url?.startsWith("blob:")) blob = await (await fetch(audio.url)).blob();
    if (!blob) throw new Error("NewToken audio reference must be a public URL or local stored audio");
    return blobToDataUrl(blob);
}

function extractVideoUrl(video: VideoResponse) {
    return firstUrl([video.video_url, video.url, video.metadata?.video_url, video.metadata?.result_url, video.metadata?.url, video.metadata?.result_urls, video.output, video.result]);
}

function firstUrl(values: unknown[]): string | null {
    for (const value of values) {
        const url = urlFromValue(value);
        if (url) return url;
    }
    return null;
}

function urlFromValue(value: unknown): string | null {
    if (typeof value === "string") return isPublicMediaUrl(value) ? value : null;
    if (Array.isArray(value)) return firstUrl(value);
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return firstUrl([record.video_url, record.url, record.result_url, record.result_urls]);
    }
    return null;
}

function readVideoError(error: VideoResponse["error"]) {
    if (!error) return "";
    return typeof error === "string" ? error : error.message || "";
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, "Video task response is empty");
}

function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>) {
    return unwrapEnvelope(payload, "Seedance task response is empty");
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && typeof payload.code === "number") {
        if (payload.code !== 0) throw new Error(payload.msg || "Request failed");
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "Request canceled";
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.error?.message || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return "Request canceled";
    return error instanceof Error ? error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "Authentication failed. Check API Key, plan permission, or model permission.";
    if (status === 429) return "Request was rate limited or quota is insufficient. Try again later.";
    return status ? `${fallback}: ${status}` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "Video download failed");
    if (payload.error?.message) throw new Error(payload.error.message);
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Failed to read local media"));
        reader.readAsDataURL(blob);
    });
}
