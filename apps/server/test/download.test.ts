import assert from "node:assert/strict";
import test from "node:test";
import { needsTranscode, pickPlayUrls, type ProbeInfo } from "../src/download.ts";

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
