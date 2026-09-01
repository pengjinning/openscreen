import { Film, FolderOpen, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import type { RecordingSessionSummary } from "@/lib/recordingSession";

function formatBytes(bytes: number): string {
	if (bytes <= 0) return "—";
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatCreatedAt(createdAtMs: number, locale: string): string {
	try {
		return new Intl.DateTimeFormat(locale, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date(createdAtMs));
	} catch {
		return new Date(createdAtMs).toLocaleString();
	}
}

interface RecordingSessionsSidebarProps {
	/** Plain filesystem path of the currently open screen recording, if any. */
	activeScreenVideoPath: string | null;
	onOpenSession: (session: RecordingSessionSummary) => void;
	/** Bump to force a reload (e.g. when the sidebar becomes visible). */
	refreshToken: number;
}

/**
 * Left-hand project list for the editor. Shows every finalized recording in the
 * app's recordings directory and reopens one on click.
 */
export function RecordingSessionsSidebar({
	activeScreenVideoPath,
	onOpenSession,
	refreshToken,
}: RecordingSessionsSidebarProps) {
	const t = useScopedT("editor");
	const { locale } = useI18n();
	const [sessions, setSessions] = useState<RecordingSessionSummary[] | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);

	const loadSessions = useCallback(async () => {
		setLoadFailed(false);
		try {
			const result = await window.electronAPI.listRecordedSessions();
			if (!result.success) {
				throw new Error(result.message || result.error || "listRecordedSessions failed");
			}
			setSessions(result.sessions ?? []);
		} catch (error) {
			console.error("Failed to list recordings:", error);
			setSessions([]);
			setLoadFailed(true);
		}
	}, []);

	// refreshToken is an intentional reload trigger (sidebar reopened / window
	// refocused); it is not referenced inside loadSessions itself.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reload trigger
	useEffect(() => {
		void loadSessions();
	}, [loadSessions, refreshToken]);

	return (
		// Width is controlled by the resizable Panel this sidebar lives in.
		<aside className="w-full min-h-0 flex flex-col border-r border-white/[0.07] bg-[#0b0c0e]">
			<header className="h-10 flex-shrink-0 flex items-center justify-between pl-3 pr-2 border-b border-white/[0.07]">
				<span className="text-[11px] font-semibold uppercase tracking-wider text-white/40">
					{t("sessionsSidebar.title")}
				</span>
				<button
					type="button"
					title={t("sessionsSidebar.refresh")}
					aria-label={t("sessionsSidebar.refresh")}
					onClick={() => void loadSessions()}
					className="p-1.5 rounded-md text-white/40 hover:text-white/90 hover:bg-white/[0.08] transition-colors"
				>
					<RefreshCw size={13} />
				</button>
			</header>

			<div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1">
				{loadFailed && (
					<button
						type="button"
						onClick={() => void loadSessions()}
						className="rounded-lg border border-white/[0.07] p-3 text-[11px] text-white/40 hover:text-white/70 hover:bg-white/[0.04] transition-colors text-left"
					>
						{t("sessionsSidebar.refresh")}
					</button>
				)}

				{!loadFailed && sessions !== null && sessions.length === 0 && (
					<div className="flex flex-col items-center gap-2 py-10 px-4 text-center">
						<Film size={18} className="text-white/20" />
						<span className="text-[11.5px] text-white/35 leading-snug">
							{t("sessionsSidebar.empty")}
						</span>
					</div>
				)}

				{sessions?.map((session) => {
					const active = activeScreenVideoPath === session.screenVideoPath;
					return (
						<div
							key={session.screenVideoPath}
							className={`group relative rounded-lg border transition-colors ${
								active
									? "border-[#34B27B]/40 bg-[#34B27B]/10"
									: "border-transparent hover:bg-white/[0.05]"
							}`}
						>
							<button
								type="button"
								onClick={() => onOpenSession(session)}
								className="w-full text-left p-2.5 pr-8 flex gap-2.5 items-start"
							>
								<div
									className={`mt-0.5 flex-shrink-0 w-8 h-8 rounded-md flex items-center justify-center ${
										active ? "bg-[#34B27B]/20 text-[#34B27B]" : "bg-white/[0.06] text-white/50"
									}`}
								>
									<Film size={15} />
								</div>
								<div className="min-w-0 flex-1">
									<div className="text-[12px] font-medium text-slate-200 truncate">
										{formatCreatedAt(session.createdAt, locale)}
									</div>
									<div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-white/35">
										<span className="flex-shrink-0">{formatBytes(session.screenVideoBytes)}</span>
										{session.webcamVideoPath && (
											<span className="px-1.5 py-px rounded bg-white/[0.08] text-white/45 truncate">
												{t("sessionsSidebar.webcam")}
											</span>
										)}
									</div>
								</div>
							</button>
							<button
								type="button"
								title={t("sessionsSidebar.reveal")}
								aria-label={t("sessionsSidebar.reveal")}
								onClick={() => void window.electronAPI.revealInFolder(session.screenVideoPath)}
								className="absolute top-1.5 right-1.5 p-1 rounded text-white/30 hover:text-white/80 hover:bg-white/[0.08] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
							>
								<FolderOpen size={12} />
							</button>
						</div>
					);
				})}
			</div>
		</aside>
	);
}
