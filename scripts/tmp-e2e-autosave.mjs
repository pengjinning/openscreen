// E2E: sidebar switch auto-save + restore round-trip.
// Setup: two test recordings in RECORDINGS_DIR; open editor on recording A,
// make an unsaved edit (aspect ratio chip), switch to B via the sidebar ->
// expect no dialog, A.openscreen created, B loaded. Switch back to A ->
// expect A's edits restored.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const FIXTURE = path.join(ROOT, "tests/fixtures/dual-audio-track.mp4");

const app = await electron.launch({
	args: [ROOT, "--no-sandbox", "--enable-unsafe-swiftshader"],
	env: { ...process.env, HEADLESS: "true" },
});

const logs = [];
app.process().stderr?.on("data", (d) => logs.push(d.toString()));

try {
	const hud = await app.firstWindow({ timeout: 60_000 });
	await hud.waitForLoadState("domcontentloaded");

	const userDataDir = await app.evaluate(({ app: a }) => a.getPath("userData"));
	const recordingsDir = path.join(userDataDir, "recordings");
	fs.mkdirSync(recordingsDir, { recursive: true });
	const videoA = path.join(recordingsDir, "recording-aaa.mp4");
	const videoB = path.join(recordingsDir, "recording-bbb.mp4");
	fs.copyFileSync(FIXTURE, videoA);
	fs.copyFileSync(FIXTURE, videoB);
	// Deterministic sidebar order: future createdAt sorts before every real
	// recording -> row 1 = B (newer), row 2 = A.
	fs.writeFileSync(
		path.join(recordingsDir, "recording-aaa.session.json"),
		JSON.stringify({ screenVideoPath: videoA, createdAt: 9000000000000 }),
	);
	fs.writeFileSync(
		path.join(recordingsDir, "recording-bbb.session.json"),
		JSON.stringify({ screenVideoPath: videoB, createdAt: 9100000000000 }),
	);
	const projectA = path.join(recordingsDir, "recording-aaa.openscreen");

	// 0) IPC unit checks in the real app.
	const ipc = await hud.evaluate(
		async (p) => {
			const ok = await window.electronAPI.saveProjectFileSilent(
				{ version: 2, media: { screenVideoPath: p.videoA }, editor: {} },
				p.projectA,
			);
			const outside = await window.electronAPI.saveProjectFileSilent(
				{ version: 2, editor: {} },
				"/tmp/evil.openscreen",
			);
			const loaded = await window.electronAPI.loadProjectFileFromPath(p.projectA);
			return { ok: ok.success, outsideRejected: outside.success === false, loaded: loaded.success };
		},
		{ videoA, projectA },
	);
	console.log("IPC checks:", JSON.stringify(ipc));
	fs.rmSync(projectA, { force: true }); // start clean for the UI flow

	// 1) Open the editor on recording A (mirrors gif-export.spec setup).
	// switchToEditor closes the HUD mid-evaluate, so don't await the result —
	// fire it and poll for the editor window instead.
	await hud
		.evaluate((p) => {
			void window.electronAPI
				.setCurrentVideoPath(p)
				.then(() => window.electronAPI.switchToEditor())
				.catch(() => {});
		}, videoA)
		.catch(() => {});
	let editor = null;
	for (let i = 0; i < 30 && !editor; i++) {
		editor = app.windows().find((w) => w.url().includes("windowType=editor"));
		if (!editor) await new Promise((r) => setTimeout(r, 500));
	}
	if (!editor) throw new Error("editor window did not open");
	await editor.waitForLoadState("domcontentloaded");
	await editor.waitForTimeout(3000);

	// 2) Show the sessions sidebar.
	const toggle = editor.getByRole("button", { name: /切换录像列表|Toggle recordings list/i });
	console.log("toggle found:", await toggle.count());
	await toggle.click();
	await editor.waitForTimeout(1000);

	// 3) Make an unsaved edit: switch aspect ratio to 9:16 via the timeline
	// toolbar dropdown (Radix portal menu).
	const arTrigger = editor.getByRole("button").filter({ hasText: /native|原始|16:9/i }).first();
	console.log("aspect trigger found:", await arTrigger.count());
	await arTrigger.click();
	await editor.waitForTimeout(500);
	const menuItem = editor.getByRole("menuitem").filter({ hasText: "9:16" }).first();
	console.log("9:16 menu item found:", await menuItem.count());
	await menuItem.click();
	await editor.waitForTimeout(800);

	// 4) Click recording B in the sidebar (row 1 = newer = B).
	const rows = editor.locator("aside .group");
	console.log("sidebar rows:", await rows.count());
	await rows.nth(0).locator("button").first().click();
	await editor.waitForTimeout(2500);

	// 5) Assertions.
	const dialogOpen = await editor
		.getByText(/保存并打开录像|Save & Open Recording|Unsaved Changes|未保存的更改/i)
		.count();
	console.log("unsaved dialog shown (want 0):", dialogOpen);
	const savedA = fs.existsSync(projectA);
	console.log("A project file auto-created:", savedA);
	if (savedA) {
		const data = JSON.parse(fs.readFileSync(projectA, "utf-8"));
		console.log(
			"A project aspectRatio (want 9:16):",
			JSON.stringify(data.editor?.aspectRatio ?? data.editor?.aspectRatio),
		);
	}

	// 6) Switch back to A (row 2) and verify the edit was restored.
	await editor.locator("aside .group").nth(1).locator("button").first().click();
	await editor.waitForTimeout(2500);
	const triggerText = await editor
		.getByRole("button")
		.filter({ hasText: /9:16/ })
		.first()
		.textContent()
		.catch(() => "");
	console.log("after reopen A, aspect trigger shows:", JSON.stringify(triggerText?.trim()));
} finally {
	await app.close().catch(() => {});
	console.log("\nstderr tail:", logs.join("").split("\n").slice(-6).join("\n"));
}
