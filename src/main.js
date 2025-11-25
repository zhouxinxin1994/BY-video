const { Plugin, MarkdownView, Notice, requestUrl } = require("obsidian");

/** 解析 “1:23” / “00:01:23” 为秒数 */
function parseTimestampToSeconds(input) {
	if (!input) return null;
	const parts = input.trim().split(":").map((p) => p.trim());
	if (parts.some((p) => p === "")) return null;

	let seconds = 0;

	if (parts.length === 1) {
		const s = Number(parts[0]);
		if (Number.isNaN(s) || s < 0) return null;
		seconds = s;
	} else if (parts.length === 2) {
		const m = Number(parts[0]);
		const s = Number(parts[1]);
		if ([m, s].some((x) => Number.isNaN(x) || x < 0)) return null;
		seconds = m * 60 + s;
	} else if (parts.length === 3) {
		const h = Number(parts[0]);
		const m = Number(parts[1]);
		const s = Number(parts[2]);
		if ([h, m, s].some((x) => Number.isNaN(x) || x < 0)) return null;
		seconds = h * 3600 + m * 60 + s;
	} else {
		return null;
	}
	return seconds;
}

/** 秒 → “mm:ss” / “hh:mm:ss” */
function formatSeconds(seconds) {
	if (seconds < 0) seconds = 0;
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	const mm = String(m).padStart(2, "0");
	const ss = String(s).padStart(2, "0");
	if (h > 0) {
		const hh = String(h).padStart(2, "0");
		return `${hh}:${mm}:${ss}`;
	} else {
		return `${mm}:${ss}`;
	}
}

/** 从剪贴板读取一个 http(s) 链接 */
async function getUrlFromClipboard() {
	try {
		if (
			typeof navigator !== "undefined" &&
			navigator.clipboard &&
			navigator.clipboard.readText
		) {
			const text = await navigator.clipboard.readText();
			if (!text) return null;
			const m = text.match(/https?:\/\/[^\s]+/);
			return m ? m[0] : null;
		}
	} catch (e) {
		console.log("读取剪贴板失败", e);
	}
	return null;
}

/** 判断是 YouTube / Bilibili / 其他 */
function detectVideoSite(url) {
	const u = url.toLowerCase();
	if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
	if (u.includes("bilibili.com")) return "bilibili";
	return null;
}

/** 提取 YouTube 视频 ID */
function getYoutubeVideoId(url) {
	try {
		const u = new URL(url.trim());
		if (u.hostname === "youtu.be") {
			return u.pathname.replace("/", "");
		}
		if (u.hostname.includes("youtube.com")) {
			const v = u.searchParams.get("v");
			if (v) return v;
			// 若已是 /embed/ 形式
			if (u.pathname.startsWith("/embed/")) {
				return u.pathname.replace("/embed/", "");
			}
		}
		return null;
	} catch (e) {
		return null;
	}
}

/** 根据普通 YouTube 链接构造 embed src（初始不带时间参数） */
function buildYoutubeEmbedSrc(url) {
	const id = getYoutubeVideoId(url);
	if (!id) return null;
	// 初始：不带 start，让时间戳控制时再加 start
	const src =
		`https://www.youtube.com/embed/${id}` +
		`?rel=0&controls=1`;
	return src;
}

/** 提取 BVID（标准 video 链接） */
function extractBvid(url) {
	try {
		const u = new URL(url.trim());
		const parts = u.pathname.split("/").filter((p) => p.length > 0);
		const idx = parts.findIndex((p) => p.toLowerCase() === "video");
		if (idx >= 0 && parts.length > idx + 1) {
			return parts[idx + 1].split("?")[0];
		}
		return null;
	} catch (e) {
		return null;
	}
}

/** 从任意 B站链接获取 bvid（包括 player 链接） */
function getBilibiliBvidFromAny(url) {
	try {
		const u = new URL(url.trim());
		if (u.hostname.includes("player.bilibili.com")) {
			const bvid = u.searchParams.get("bvid");
			if (bvid) return bvid;
		}
		const fromVideo = extractBvid(url);
		if (fromVideo) return fromVideo;
		return null;
	} catch (e) {
		return null;
	}
}

/** 根据 BVID 构造 B站 embed src（初始不带 t 参数） */
function buildBilibiliEmbedSrcFromBvid(bvid) {
	if (!bvid) return null;
	const src = `https://player.bilibili.com/player.html?bvid=${bvid}&page=1&high_quality=1`;
	return src;
}

/** 给 iframe 的 src 加上 / 更新起始时间参数
 *  - YouTube: 使用 start=seconds
 *  - B站: 使用 t=seconds
 */
function buildIframeSrcWithStart(originalSrc, seconds) {
	if (!originalSrc) return originalSrc;
	try {
		const u = new URL(originalSrc);
		const lowerHost = u.hostname.toLowerCase();
		// YouTube embed
		if (lowerHost.includes("youtube.com")) {
			u.searchParams.set("start", String(seconds));
			return u.toString();
		}
		// Bilibili player
		if (lowerHost.includes("bilibili.com")) {
			u.searchParams.set("t", String(seconds));
			return u.toString();
		}
		// 其他：默认加/改 t
		u.searchParams.set("t", String(seconds));
		return u.toString();
	} catch (e) {
		// URL 解析失败就用简单字符串处理
		const hasQuery = originalSrc.includes("?");
		const connector = hasQuery ? "&" : "?";
		return `${originalSrc.split(/[?&]t=\d*/)[0]}${connector}t=${seconds}`;
	}
}

/** 获取 B站视频元数据：标题 / 作者 / 简介 / 标准 URL */
async function fetchBilibiliMeta(url) {
	const bvid = getBilibiliBvidFromAny(url);
	if (!bvid) return null;
	const apiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
	const res = await requestUrl({ url: apiUrl, method: "GET" });
	const json = res.json;
	if (!json || json.code !== 0 || !json.data) return null;
	const data = json.data;
	return {
		title: data.title || "",
		author: data.owner?.name || "",
		description: data.desc || "",
		url: `https://www.bilibili.com/video/${data.bvid || bvid}`,
		source: "bilibili"
	};
}

/** 获取 YouTube 元数据：标题 / 作者（简介需要官方 API，这里先不搞） */
async function fetchYouTubeMeta(url) {
	try {
		const apiUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
			url
		)}&format=json`;
		const res = await requestUrl({ url: apiUrl, method: "GET" });
		const j = res.json;
		if (!j) return null;
		return {
			title: j.title || "",
			author: j.author_name || "",
			description: "", // oEmbed 不提供简介
			url,
			source: "youtube"
		};
	} catch (e) {
		console.log("fetchYouTubeMeta failed", e);
		return null;
	}
}

/** 把视频元数据渲染成一小段 markdown，插到 iframe 后面 */
function buildMetaMarkdown(meta) {
	if (!meta) return "";
	const lines = [];
	lines.push(`> **Title:** ${meta.title || ""}`);
	if (meta.author) lines.push(`> **Author:** ${meta.author}`);
	if (meta.url) lines.push(`> **URL:** ${meta.url}`);
	if (meta.source) lines.push(`> **Source:** ${meta.source}`);
	lines.push(`>`);
	if (meta.description) {
		lines.push(`> **Description:**`);
		lines.push(`>`);
		// 简介多行，逐行加 "> "
		const descLines = meta.description.split(/\r?\n/);
		for (const dl of descLines) {
			lines.push(`> ${dl}`);
		}
	} else {
		lines.push(`> （无简介）`);
	}
	return lines.join("\n") + "\n\n";
}

module.exports = class VideoTimestampIframePlugin extends Plugin {
	onload() {
		console.log("VideoTimestampIframePlugin loaded");

		// 1. markdown 后处理：给时间戳加点击事件
		this.registerMarkdownPostProcessor((element, ctx) => {
			const timestamps = element.querySelectorAll(".vls-ts");
			timestamps.forEach((ts) => {
				// 防止重复绑定
				if (ts.dataset.vlsBound === "1") return;
				ts.dataset.vlsBound = "1";

				ts.addEventListener("click", (ev) => {
					ev.preventDefault();
					ev.stopPropagation();

					const secStr = ts.getAttribute("data-vls-seconds") || "0";
					const seconds = Number(secStr);
					if (Number.isNaN(seconds) || seconds < 0) {
						new Notice("无效的时间戳。");
						return;
					}

					// 在同一页中查找 iframe
					const root =
						ts.closest(
							".markdown-reading-view, .markdown-preview-view"
						) || document;
					const iframe = root.querySelector(
						"iframe.vls-video-iframe"
					);

					if (!iframe) {
						new Notice("未找到同一页中的视频播放器（vls-video-iframe）。");
						return;
					}

					const oldSrc = iframe.getAttribute("src") || "";
					const newSrc = buildIframeSrcWithStart(oldSrc, seconds);
					if (newSrc && newSrc !== oldSrc) {
						iframe.setAttribute("src", newSrc);
					}
				});
			});
		});

		// 2. 命令：从剪贴板插入 B站 / YouTube 视频 iframe + 元数据
		this.addCommand({
			id: "insert-video-iframe-from-clipboard",
			name: "插入视频 + 元数据（剪贴板 B站/YouTube 链接）",
			callback: () => this.insertVideoIframeFromClipboard()
		});

		// 3. 命令：选中文本 → 插入时间戳行
		this.addCommand({
			id: "selection-to-video-timestamp",
			name: "选中文本 → 视频时间戳（同页控制 iframe）",
			callback: () => this.insertTimestampLineFromSelection()
		});
	}

	onunload() {
		console.log("VideoTimestampIframePlugin unloaded");
	}

	/** 插入 iframe：自动识别剪贴板中是 B站或 YouTube，并拉取标题/简介 */
	async insertVideoIframeFromClipboard() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("当前未打开 Markdown 文档。");
			return;
		}
		const editor = view.editor;

		const url = await getUrlFromClipboard();
		if (!url) {
			new Notice("剪贴板中未检测到链接，请先复制 B站或 YouTube 视频链接。");
			return;
		}

		const site = detectVideoSite(url);
		if (!site) {
			new Notice("该链接不是 B站或 YouTube 视频链接。");
			return;
		}

		// 先拿元数据（标题/简介）
		let meta = null;
		try {
			if (site === "bilibili") {
				meta = await fetchBilibiliMeta(url);
			} else if (site === "youtube") {
				meta = await fetchYouTubeMeta(url);
			}
		} catch (e) {
			console.log("fetch meta failed", e);
		}

		let src = null;
		let siteName = "";

		if (site === "youtube") {
			src = buildYoutubeEmbedSrc(url);
			siteName = "YouTube";
		} else if (site === "bilibili") {
			// 可能已经是 player 链接
			if (url.toLowerCase().includes("player.bilibili.com")) {
				src = url;
			} else {
				const bvid = getBilibiliBvidFromAny(url);
				if (!bvid) {
					new Notice(
						"无法从链接中提取 BVID，请确认链接格式（https://www.bilibili.com/video/BV...）。"
					);
					return;
				}
				src = buildBilibiliEmbedSrcFromBvid(bvid);
			}
			siteName = "B站";
		}

		if (!src) {
			new Notice("构造 iframe 播放地址失败。");
			return;
		}
		const metaBlock = meta ? buildMetaMarkdown(meta) : "";
		const iframeHtml =
			`<div class="vls-video-container">\n` +
			`  <iframe class="vls-video-iframe" src="${src}" ` +
			`allow="autoplay; encrypted-media; picture-in-picture; fullscreen" ` +
			`allowfullscreen frameborder="0"></iframe>\n` +
			`</div>\n`;

		

		const cursor = editor.getCursor();
		editor.replaceRange(iframeHtml + "\n" + metaBlock, cursor);

		new Notice(`已插入 ${siteName} 视频播放器和元数据。`);
	}

	/** 选中文本 → 插入时间戳行
	 *  选中形如： 1:23 I'm afraid I can't do that.
	 *  结果形如：
	 *  - <span class="vls-ts" data-vls-seconds="83">[01:23]</span> I'm afraid I can't do that.
	 */
	async insertTimestampLineFromSelection() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("当前未打开 Markdown 文档。");
			return;
		}
		const editor = view.editor;

		const selection = editor.getSelection();
		if (!selection || selection.trim().length === 0) {
			new Notice("请先选中一行文本，例如：1:23 句子内容");
			return;
		}

		const m = selection.trim().match(/^(\S+)\s*(.*)$/);
		if (!m) {
			new Notice(
				"选中文本格式不正确，示例：1:23 I'm afraid I can't do that."
			);
			return;
		}

		const tsStr = m[1];
		const note = m[2] || "";

		const seconds = parseTimestampToSeconds(tsStr);
		if (seconds == null) {
			new Notice("时间格式不正确，示例：1:23 或 00:01:23");
			return;
		}

		const label = formatSeconds(seconds);
		const line =
			`- <span class="vls-ts" data-vls-seconds="${seconds}">` +
			`[${label}]</span>${note ? " " + note : ""}\n`;

		editor.replaceSelection(line);
	}
};
