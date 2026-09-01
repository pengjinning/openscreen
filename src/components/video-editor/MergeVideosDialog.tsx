import {
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	FolderOpen,
	Loader2,
	Plus,
	Upload,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { computeMergePlan, type MergeClipInfo } from "@/lib/merge/mergePlan";
import {
	type MergeMode,
	type MergeProgress,
	mergeVideos,
	probeVideoFile,
} from "@/lib/merge/videoMerger";
import { getExportFolder, parentDirectoryOf, saveUserPreferences } from "@/lib/userPreferences";
import { cn } from "@/lib/utils";

interface MergeClipEntry {
	id: string;
	path: string;
	name: string;
	info: MergeClipInfo | null;
	probeError: boolean;
}

type MergeStatus = "editing" | "merging" | "done" | "error";

interface MergeVideosDialogProps {
	isOpen: boolean;
	onClose: () => void;
	/** Called with the merged file path when the user chooses to open it in the editor. */
	onOpenInEditor?: (path: string) => void;
}

function formatDuration(seconds: number): string {
	const total = Math.round(seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatFileSize(bytes: number): string {
	if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

let clipIdCounter = 0;

export function MergeVideosDialog({ isOpen, onClose, onOpenInEditor }: MergeVideosDialogProps) {
	const te = useScopedT("editor");
	const [clips, setClips] = useState<MergeClipEntry[]>([]);
	const [status, setStatus] = useState<MergeStatus>("editing");
	const [progress, setProgress] = useState<MergeProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [failedFile, setFailedFile] = useState<string | null>(null);
	const [resultPath, setResultPath] = useState<string | null>(null);
	const [resultMode, setResultMode] = useState<MergeMode | null>(null);
	const [isPicking, setIsPicking] = useState(false);
	const [isDraggingOver, setIsDraggingOver] = useState(false);
	const [dropError, setDropError] = useState<string | null>(null);
	const dragDepthRef = useRef(0);
	const abortRef = useRef<AbortController | null>(null);

	const isBusy = status === "merging";

	// Reset transient state whenever the dialog is (re)opened.
	useEffect(() => {
		if (isOpen) {
			setStatus("editing");
			setProgress(null);
			setError(null);
			setFailedFile(null);
			setResultPath(null);
			setResultMode(null);
			setDropError(null);
		}
	}, [isOpen]);

	useEffect(() => {
		return () => {
			abortRef.current?.abort();
		};
	}, []);

	const probedClips = useMemo(
		() => clips.filter((clip) => clip.info !== null).map((clip) => clip.info as MergeClipInfo),
		[clips],
	);

	const plan = useMemo(
		() => (probedClips.length >= 2 ? computeMergePlan(probedClips) : null),
		[probedClips],
	);

	const hasProbeErrors = clips.some((clip) => clip.probeError);
	const canMerge = clips.length >= 2 && !hasProbeErrors && probedClips.length === clips.length;

	// Appends new (deduplicated) clips and probes them one by one, flagging
	// per-clip failures. Shared by the file picker and drag & drop.
	const addAndProbePaths = useCallback(async (paths: string[]) => {
		if (paths.length === 0) return;

		let addedPaths: string[] = [];
		setClips((previous) => {
			const existingPaths = new Set(previous.map((clip) => clip.path));
			const newEntries: MergeClipEntry[] = [];
			for (const path of paths) {
				if (existingPaths.has(path)) continue;
				existingPaths.add(path);
				clipIdCounter += 1;
				newEntries.push({
					id: `clip-${clipIdCounter}`,
					path,
					name: path.split(/[\\/]/).pop() ?? path,
					info: null,
					probeError: false,
				});
				addedPaths.push(path);
			}
			return [...previous, ...newEntries];
		});

		// Probe new files one by one; failures are flagged per clip.
		for (const path of addedPaths) {
			const name = path.split(/[\\/]/).pop() ?? path;
			try {
				const info = await probeVideoFile({ path, name });
				setClips((previous) =>
					previous.map((clip) => (clip.path === path ? { ...clip, info } : clip)),
				);
			} catch (error) {
				console.error("Failed to probe video:", error);
				setClips((previous) =>
					previous.map((clip) => (clip.path === path ? { ...clip, probeError: true } : clip)),
				);
			}
		}
	}, []);

	const addFiles = useCallback(async () => {
		if (isPicking) return;
		setIsPicking(true);
		try {
			const result = await window.electronAPI.openVideoFilePicker({ multiple: true });
			if (result.canceled || !result.success || !result.paths) return;
			setDropError(null);
			await addAndProbePaths(result.paths);
		} finally {
			setIsPicking(false);
		}
	}, [isPicking, addAndProbePaths]);

	const handleDragEnter = useCallback(
		(e: React.DragEvent) => {
			if (isBusy) return;
			e.preventDefault();
			// Track enter/leave depth: child elements fire their own events, and a
			// naive leave handler would flicker the overlay between children.
			dragDepthRef.current += 1;
			if (e.dataTransfer.types.includes("Files")) {
				setIsDraggingOver(true);
			}
		},
		[isBusy],
	);

	const handleDragOver = useCallback(
		(e: React.DragEvent) => {
			if (isBusy) return;
			e.preventDefault();
			if (e.dataTransfer.types.includes("Files")) {
				e.dataTransfer.dropEffect = "copy";
			}
		},
		[isBusy],
	);

	const handleDragLeave = useCallback(
		(e: React.DragEvent) => {
			if (isBusy) return;
			e.preventDefault();
			dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
			if (dragDepthRef.current === 0) {
				setIsDraggingOver(false);
			}
		},
		[isBusy],
	);

	const handleDrop = useCallback(
		async (e: React.DragEvent) => {
			if (isBusy) return;
			e.preventDefault();
			dragDepthRef.current = 0;
			setIsDraggingOver(false);
			if (isPicking) return;

			// Resolve real paths via Electron's webUtils (File.path was removed in 32+).
			const droppedPaths: string[] = [];
			for (const file of Array.from(e.dataTransfer.files)) {
				try {
					const filePath = window.electronAPI.getPathForFile(file);
					if (filePath) droppedPaths.push(filePath);
				} catch {
					// Skip items without a resolvable path.
				}
			}
			if (droppedPaths.length === 0) {
				setDropError(te("merge.dropUnsupported"));
				return;
			}

			setIsPicking(true);
			try {
				// Dropped paths weren't approved through a native dialog; ask the
				// main process to run them through the same approval check.
				const result = await window.electronAPI.approveVideoFilePaths(droppedPaths);
				if (!result.success || !result.approved || result.approved.length === 0) {
					setDropError(te("merge.dropUnsupported"));
					return;
				}
				setDropError(null);
				await addAndProbePaths(result.approved);
			} finally {
				setIsPicking(false);
			}
		},
		[isBusy, isPicking, addAndProbePaths, te],
	);

	const removeClip = useCallback((id: string) => {
		setClips((previous) => previous.filter((clip) => clip.id !== id));
	}, []);

	const moveClip = useCallback((id: string, direction: -1 | 1) => {
		setClips((previous) => {
			const index = previous.findIndex((clip) => clip.id === id);
			const target = index + direction;
			if (index < 0 || target < 0 || target >= previous.length) return previous;
			const next = [...previous];
			const [entry] = next.splice(index, 1);
			next.splice(target, 0, entry);
			return next;
		});
	}, []);

	const handleMerge = useCallback(async () => {
		if (!canMerge || isBusy) return;

		const pickResult = await window.electronAPI.pickExportSavePath(
			`merged-${Date.now()}.mp4`,
			getExportFolder(),
		);
		if (pickResult.canceled || !pickResult.success || !pickResult.path) return;

		const controller = new AbortController();
		abortRef.current = controller;

		setStatus("merging");
		setProgress(null);
		setError(null);
		setFailedFile(null);
		setResultPath(null);
		setResultMode(null);

		const result = await mergeVideos({
			files: clips.map((clip) => ({ path: clip.path, name: clip.name })),
			signal: controller.signal,
			onProgress: setProgress,
		});

		if (!result.success || !result.blob) {
			abortRef.current = null;
			setStatus("error");
			setError(result.error ?? "Unknown error");
			setFailedFile(result.failedFile ?? null);
			if (!result.canceled) {
				toast.error(te("merge.mergeFailed"));
			}
			return;
		}

		try {
			const arrayBuffer = await result.blob.arrayBuffer();
			const writeResult = await window.electronAPI.writeExportToPath(arrayBuffer, pickResult.path);
			if (!writeResult.success) {
				setStatus("error");
				setError(writeResult.message ?? writeResult.error ?? "Failed to save merged video");
				return;
			}

			const folder = parentDirectoryOf(pickResult.path);
			if (folder) {
				saveUserPreferences({ exportFolder: folder });
			}
			setResultPath(pickResult.path);
			setResultMode(result.mode ?? null);
			setStatus("done");
			toast.success(te("merge.mergeSucceeded"));
		} catch (error) {
			console.error("Failed to save merged video:", error);
			setStatus("error");
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			abortRef.current = null;
		}
	}, [canMerge, isBusy, clips, te]);

	const cancelMerge = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	const showInFolder = useCallback(() => {
		if (resultPath) {
			window.electronAPI.revealInFolder(resultPath);
		}
	}, [resultPath]);

	const openInEditor = useCallback(() => {
		if (resultPath && onOpenInEditor) {
			onOpenInEditor(resultPath);
			onClose();
		}
	}, [resultPath, onOpenInEditor, onClose]);

	const requestClose = useCallback(() => {
		if (isBusy) return;
		onClose();
	}, [isBusy, onClose]);

	if (!isOpen) return null;

	const overallPercent = Math.round((progress?.overallProgress ?? 0) * 100);

	return (
		<>
			<div className="fixed inset-0 z-[9998] bg-black/80 backdrop-blur-md animate-in fade-in duration-200" />
			<div
				className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-[9999] bg-[#09090b] rounded-2xl shadow-2xl border border-white/10 p-6 w-[92vw] max-w-xl animate-in zoom-in-95 duration-200 flex flex-col max-h-[85vh] relative"
				onDragEnter={handleDragEnter}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				{/* Drop overlay */}
				{isDraggingOver && status !== "done" && status !== "merging" && (
					<div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-[#34B27B] bg-[#09090b]/90">
						<Upload className="mb-3 h-10 w-10 text-[#34B27B]" />
						<p className="text-base font-semibold text-[#34B27B]">{te("merge.dropOverlay")}</p>
					</div>
				)}
				{/* Header */}
				<div className="flex items-center justify-between mb-4 shrink-0">
					<div className="flex flex-col gap-0.5">
						<h2 className="text-lg font-semibold text-slate-200">
							{status === "done" ? te("merge.successTitle") : te("merge.title")}
						</h2>
						{status !== "done" && (
							<p className="text-xs text-slate-500">{te("merge.description")}</p>
						)}
					</div>
					{!isBusy && (
						<button
							type="button"
							onClick={requestClose}
							className="rounded-lg p-1.5 text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-colors"
							aria-label={te("merge.close")}
						>
							<X className="h-4 w-4" />
						</button>
					)}
				</div>

				{status === "done" ? (
					/* ---------- Success view ---------- */
					<div className="flex flex-col items-center gap-4 py-8">
						<div className="w-14 h-14 rounded-full bg-[#34B27B]/20 flex items-center justify-center ring-1 ring-[#34B27B]/50">
							<CheckCircle2 className="w-7 h-7 text-[#34B27B]" />
						</div>
						<div className="flex flex-col items-center gap-1 text-center">
							<p className="text-base font-semibold text-slate-200">{te("merge.successMessage")}</p>
							{resultPath && (
								<p className="text-xs text-slate-500 break-all max-w-sm">
									{resultPath.split(/[\\/]/).pop()}
									{resultMode === "remux" ? ` · ${te("merge.modeRemux")}` : ""}
									{resultMode === "transcode" ? ` · ${te("merge.modeTranscode")}` : ""}
								</p>
							)}
						</div>
						<div className="flex items-center gap-2 mt-2">
							{resultPath && (
								<button
									type="button"
									onClick={showInFolder}
									className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 text-sm font-medium transition-colors"
								>
									<FolderOpen className="w-4 h-4" />
									{te("merge.showInFolder")}
								</button>
							)}
							{resultPath && onOpenInEditor && (
								<button
									type="button"
									onClick={openInEditor}
									className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-[#34B27B] hover:bg-[#2d9e6c] text-white text-sm font-medium transition-colors"
								>
									{te("merge.openInEditor")}
								</button>
							)}
						</div>
					</div>
				) : status === "merging" ? (
					/* ---------- Progress view ---------- */
					<div className="flex flex-col gap-5 py-4">
						<div className="flex items-center gap-3">
							<Loader2 className="w-5 h-5 text-[#34B27B] animate-spin shrink-0" />
							<div className="flex flex-col gap-0.5 min-w-0">
								<span className="text-sm font-medium text-slate-200">
									{progress?.phase === "reading" && te("merge.phaseReading")}
									{progress?.phase === "analyzing" && te("merge.phaseAnalyzing")}
									{progress?.phase === "finalizing" && te("merge.phaseFinalizing")}
									{(!progress || progress.phase === "merging") &&
										(progress && progress.clipCount > 0
											? te("merge.phaseMergingClip", {
													index: String((progress?.clipIndex ?? 0) + 1),
													count: String(progress?.clipCount ?? clips.length),
													name: clips[progress?.clipIndex ?? 0]?.name ?? "",
												})
											: te("merge.phaseMerging"))}
								</span>
								{progress?.mode && (
									<span className="text-xs text-slate-500">
										{progress.mode === "remux" ? te("merge.modeRemux") : te("merge.modeTranscode")}
									</span>
								)}
							</div>
							<span className="ml-auto text-sm text-slate-400 tabular-nums">{overallPercent}%</span>
						</div>
						<div className="h-2 rounded-full bg-white/5 overflow-hidden">
							<div
								className="h-full rounded-full bg-[#34B27B] transition-[width] duration-150"
								style={{ width: `${overallPercent}%` }}
							/>
						</div>
						<button
							type="button"
							onClick={cancelMerge}
							className="self-center px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 text-sm font-medium transition-colors"
						>
							{te("merge.cancelMerge")}
						</button>
					</div>
				) : (
					/* ---------- Editing + error view ---------- */
					<>
						{(status === "error" || hasProbeErrors) && (
							<div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-300 shrink-0">
								{status === "error" && (
									<span>
										{te("merge.mergeFailedWithError", {
											error: failedFile ? `${failedFile}: ${error ?? ""}` : (error ?? ""),
										})}
									</span>
								)}
								{status !== "error" && hasProbeErrors && <span>{te("merge.probeFailedHint")}</span>}
							</div>
						)}

						{dropError && (
							<div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-300 shrink-0">
								{dropError}
							</div>
						)}

						{/* Clip list */}
						<div className="flex flex-col min-h-0 flex-1 overflow-hidden rounded-xl border border-white/10 bg-black/30">
							<div className="min-h-0 overflow-y-auto flex-1">
								{clips.length === 0 ? (
									<div className="flex flex-col items-center justify-center gap-2 py-12 px-6 text-center">
										<Upload className="w-6 h-6 text-slate-600" />
										<p className="text-sm text-slate-500">{te("merge.emptyHint")}</p>
										<p className="text-xs text-slate-600">{te("merge.emptyDropHint")}</p>
									</div>
								) : (
									<ul className="divide-y divide-white/5">
										{clips.map((clip, index) => (
											<li key={clip.id} className="flex items-center gap-3 px-3.5 py-2.5">
												<span className="w-5 text-center text-xs text-slate-600 tabular-nums shrink-0">
													{index + 1}
												</span>
												<div className="flex flex-col min-w-0 flex-1 gap-0.5">
													<span className="text-sm text-slate-300 truncate">{clip.name}</span>
													{clip.probeError ? (
														<span className="text-xs text-red-400">{te("merge.probeFailed")}</span>
													) : clip.info ? (
														<span className="text-xs text-slate-500">
															{formatDuration(clip.info.duration)} · {clip.info.width}×
															{clip.info.height} · {formatFileSize(clip.info.byteSize)}
														</span>
													) : (
														<span className="text-xs text-slate-600 flex items-center gap-1.5">
															<Loader2 className="w-3 h-3 animate-spin" />
															{te("merge.probing")}
														</span>
													)}
												</div>
												<div className="flex items-center gap-0.5 shrink-0">
													<button
														type="button"
														onClick={() => moveClip(clip.id, -1)}
														disabled={index === 0}
														className="rounded-md p-1.5 text-slate-500 hover:text-slate-200 hover:bg-white/5 disabled:opacity-30 disabled:pointer-events-none transition-colors"
														aria-label={te("merge.moveUp")}
													>
														<ChevronUp className="w-4 h-4" />
													</button>
													<button
														type="button"
														onClick={() => moveClip(clip.id, 1)}
														disabled={index === clips.length - 1}
														className="rounded-md p-1.5 text-slate-500 hover:text-slate-200 hover:bg-white/5 disabled:opacity-30 disabled:pointer-events-none transition-colors"
														aria-label={te("merge.moveDown")}
													>
														<ChevronDown className="w-4 h-4" />
													</button>
													<button
														type="button"
														onClick={() => removeClip(clip.id)}
														className="rounded-md p-1.5 text-slate-500 hover:text-red-400 hover:bg-white/5 transition-colors"
														aria-label={te("merge.remove")}
													>
														<X className="w-4 h-4" />
													</button>
												</div>
											</li>
										))}
									</ul>
								)}
							</div>

							{/* Summary footer */}
							<div className="border-t border-white/10 px-3.5 py-2.5 flex items-center gap-3 text-xs text-slate-500 shrink-0">
								<span>{te("merge.clipCount", { count: String(clips.length) })}</span>
								{plan && probedClips.length === clips.length && clips.length >= 2 && (
									<>
										<span className="text-slate-700">·</span>
										<span>
											{te("merge.totalDuration")} {formatDuration(plan.totalDuration)}
										</span>
										<span className="text-slate-700">·</span>
										<span>
											{te("merge.outputResolution")} {plan.width}×{plan.height}
										</span>
									</>
								)}
							</div>
						</div>

						{/* Actions */}
						<div className="flex items-center justify-between mt-4 shrink-0">
							<button
								type="button"
								onClick={addFiles}
								disabled={isPicking || isBusy}
								className={cn(
									"flex items-center gap-2 px-3.5 py-2 rounded-lg border border-dashed border-white/20",
									"text-slate-300 text-sm font-medium transition-colors",
									"hover:border-[#34B27B]/60 hover:text-slate-100 hover:bg-[#34B27B]/5",
									"disabled:opacity-50 disabled:pointer-events-none",
								)}
							>
								{isPicking ? (
									<Loader2 className="w-4 h-4 animate-spin" />
								) : (
									<Plus className="w-4 h-4" />
								)}
								{te("merge.addFiles")}
							</button>
							<div className="flex items-center gap-2">
								<button
									type="button"
									onClick={requestClose}
									className="px-4 py-2 rounded-lg text-slate-400 hover:text-slate-200 text-sm font-medium transition-colors"
								>
									{te("merge.close")}
								</button>
								<button
									type="button"
									onClick={handleMerge}
									disabled={!canMerge || isPicking || isBusy}
									className={cn(
										"flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-medium transition-colors",
										"bg-[#34B27B] hover:bg-[#2d9e6c] active:bg-[#27885c]",
										"disabled:opacity-40 disabled:pointer-events-none",
									)}
								>
									{te("merge.mergeButton")}
								</button>
							</div>
						</div>
					</>
				)}
			</div>
		</>
	);
}
