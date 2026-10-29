import assert from "node:assert/strict";
import test from "node:test";
import { estimateEta, needsTranscode, parseFfmpegOutTime, parseYtDlpProgress, pickPlayUrls, type ProbeInfo } from "../src/download.ts";

const ipadFriendly: ProbeInfo = { formatName: "mov,mp4,m4a,3gp,3g2,mj2", bitRate: 1_500_000, video: { codec: "h264", width: 1280, height: 720, pixFmt: "yuv420p" }, audioCodec: "aac" };

test("720p 以内的 H.264/AAC MP4 不转码，其他情况都转码", () => {
  assert.equal(needsTranscode(ipadFriendly), false);
  assert.equal(needsTranscode({ ...ipadFriendly, video: { ...ipadFriendly.video!, width: 720, height: 1280 } }), false, "竖屏 720p");
  assert.equal(needsTranscode({ ...ipadFriendly, video: { ...ipadFriendly.video!, codec: "hevc" } }), true, "iPhone HEVC");
  assert.equal(needsTranscode({ ...ipadFriendly, video: { ...ipadFriendly.video!, width: 1920, height: 1080 } }), true, "1080p");
  assert.equal(needsTranscode({ ...ipadFriendly, bitRate: 8_000_000 }), true, "码率过高");
  assert.equal(needsTranscode({ ...ipadFriendly, formatName: "matroska,webm" }), true, "不是 MP4");
  assert.equal(needsTranscode({ ...ipadFriendly, audioCodec: "opus" }), true, "音频不是 AAC");
  assert.equal(needsTranscode({ ...ipadFriendly, audioCodec: undefined }), false, "没有音轨");
  assert.equal(needsTranscode({ formatName: "mp4", bitRate: 0 }), false, "没有视频流的文件交给播放端报错");
});

test("下载进度能算出剩余时间，刚开始的不到 1 秒不估算", () => {
  assert.deepEqual(estimateEta(5 * 1024 * 1024, 20 * 1024 * 1024, 1_000, 11_000), { etaSeconds: 30, speedBps: (5 * 1024 * 1024) / 10 });
  assert.equal(estimateEta(1000, 9000, 1_000, 1_200).etaSeconds, null);
  assert.equal(estimateEta(1000, null, 1_000, 5_000).etaSeconds, null);
});

test("能从 yt-dlp 和 ffmpeg 的输出里读出进度", () => {
  const parsed = parseYtDlpProgress("[download]  25.0% of 8.00MiB at 2.00MiB/s ETA 00:03");
  assert.equal(parsed?.percent, 25);
  assert.equal(parsed?.totalBytes, 8 * 1024 * 1024);
  assert.equal(parsed?.speedBps, 2 * 1024 * 1024);
  assert.equal(parsed?.etaSeconds, 3);
  assert.equal(parseYtDlpProgress("[download]  10.0% of 1.50GiB at 500.00KiB/s ETA 01:02:03")?.etaSeconds, 3723);
  assert.equal(parseYtDlpProgress("not progress"), null);
  assert.equal(parseFfmpegOutTime("out_time=00:01:30.50"), 90.5);
  assert.equal(parseFfmpegOutTime("progress=continue"), null);
});

test("抖音视频优先选不超过 720p 的最高码率 H.264", () => {
  const urls = pickPlayUrls({
    play_addr: { url_list: ["default"] },
    bit_rate: [
      { bit_rate: 2_000_000, is_h265: 0, play_addr: { url_list: ["h264-1080"], width: 1440, height: 1080 } },
      { bit_rate: 900_000, is_h265: 1, play_addr: { url_list: ["h265-720"], width: 1280, height: 720 } },
      { bit_rate: 600_000, is_h265: 0, play_addr: { url_list: ["h264-540"], width: 1024, height: 576 } },
      { bit_rate: 800_000, is_h265: 0, play_addr: { url_list: ["h264-720-portrait"], width: 720, height: 1280 } },
    ],
  });
  assert.deepEqual(urls, ["h264-720-portrait"]);
});

test("没有合适清晰度时退回最高码率 H.264，再退回默认地址", () => {
  assert.deepEqual(pickPlayUrls({ bit_rate: [{ bit_rate: 1, is_h265: 0, play_addr: { url_list: ["only-1080"], width: 1920, height: 1080 } }] }), ["only-1080"]);
  assert.deepEqual(pickPlayUrls({ play_addr: { url_list: ["default"] }, bit_rate: [] }), ["default"]);
});
