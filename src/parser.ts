/** Cloudflare Worker 主入口 - 路由分发与请求处理 */

import { parseDouyinVideo } from './parser';
import { successResponse, errorResponse, optionsResponse } from './utils';

/** Workers 环境变量绑定 */
interface Env {}

/** 前端页面 HTML */
import PLAYER_HTML from './player.html';

/** 赵乃吉 sec_user_id */
const NAIJI_SEC_USER_ID =
  'MS4wLjABAAAAMzF2DXTalH_LLD9WcbmgMT_lCLg3Prt7xLxHDNBCs0Y';

/** Worker 入口 */
export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return optionsResponse();
    }

    switch (pathname) {
      case '/':
        return handleIndex();

      case '/api/parse':
        return handleParse(request, url);

      case '/api/proxy':
        return handleProxy(url);

      case '/api/health':
        return handleHealth();

      // 🆕 赵乃吉最新作品
      case '/api/naiji':
        return handleNaiji(request);

      default:
        return errorResponse('接口不存在', 404);
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * 首页
 */
function handleIndex(): Response {
  return new Response(PLAYER_HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}

/**
 * 原有视频解析接口
 *
 * GET /api/parse?url=<douyin_share_url>
 */
async function handleParse(
  request: Request,
  url: URL
): Promise<Response> {
  if (request.method !== 'GET') {
    return errorResponse('仅支持 GET 请求', 405);
  }

  const douyinUrl = url.searchParams.get('url');

  if (!douyinUrl) {
    return errorResponse(
      '缺少必要参数: url。用法: /api/parse?url=<抖音分享链接>'
    );
  }

  const decodedUrl = douyinUrl.trim();

  try {
    const videoInfo = await parseDouyinVideo(decodedUrl);
    return successResponse(videoInfo);
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : '未知错误';

    return errorResponse(errorMessage, 500);
  }
}

/**
 * 视频代理
 *
 * GET /api/proxy?url=<cdn_url>
 */
async function handleProxy(url: URL): Promise<Response> {
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    return errorResponse('缺少必要参数: url', 400);
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        Referer: 'https://www.douyin.com/',
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
      },
    });

    const headers = new Headers();

    const copyHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'cache-control',
      'etag',
      'last-modified',
    ];

    for (const h of copyHeaders) {
      const v = response.headers.get(h);

      if (v) {
        headers.set(h, v);
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (e) {
    return errorResponse(
      '代理视频流失败: ' +
        (e instanceof Error ? e.message : String(e)),
      500
    );
  }
}

/**
 * 健康检查
 */
function handleHealth(): Response {
  return successResponse({
    status: 'healthy',
    service: 'douyin-video-parser',
    version: '1.1.0',
  });
}

/**
 * 🆕 赵乃吉最新作品接口
 *
 * GET /api/naiji
 *
 * 通过 iesdouyin 用户分享页获取 _ROUTER_DATA，
 * 从其中递归寻找作品数据，并按照 create_time
 * 找到最新的一条。
 */
async function handleNaiji(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return errorResponse('仅支持 GET 请求', 405);
  }

  const shareUrl =
    `https://www.iesdouyin.com/share/user/${NAIJI_SEC_USER_ID}`;

  try {
    const response = await fetch(shareUrl, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 13; Pixel 7) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/126.0.0.0 Mobile Safari/537.36',

        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

        'Accept-Language':
          'zh-CN,zh;q=0.9,en;q=0.8',

        Referer: 'https://www.douyin.com/',
      },
    });

    if (!response.ok) {
      return errorResponse(
        `请求 iesdouyin 用户页面失败: HTTP ${response.status}`,
        502
      );
    }

    const html = await response.text();

    /**
     * 找到 _ROUTER_DATA
     */
    const marker = 'window._ROUTER_DATA';

    const markerIndex = html.indexOf(marker);

    if (markerIndex === -1) {
      return successResponse({
        code: 502,
        author: '赵乃吉',
        sec_user_id: NAIJI_SEC_USER_ID,
        message: '页面中没有找到 _ROUTER_DATA',
        source: shareUrl,
        html_length: html.length,
      });
    }

    /**
     * 找到 JSON 开始位置
     *
     * window._ROUTER_DATA = {...}
     */
    const jsonStart = html.indexOf(
      '{',
      markerIndex
    );

    if (jsonStart === -1) {
      return successResponse({
        code: 502,
        author: '赵乃吉',
        sec_user_id: NAIJI_SEC_USER_ID,
        message: '未找到 _ROUTER_DATA JSON',
        source: shareUrl,
      });
    }

    const jsonText = extractJsonObject(
      html,
      jsonStart
    );

    if (!jsonText) {
      return successResponse({
        code: 502,
        author: '赵乃吉',
        sec_user_id: NAIJI_SEC_USER_ID,
        message: '_ROUTER_DATA JSON 提取失败',
        source: shareUrl,
      });
    }

    const routerData = JSON.parse(jsonText);

    /**
     * 递归寻找作品对象
     */
    const awemes = findAwemeObjects(routerData);

    if (awemes.length === 0) {
      return successResponse({
        code: 404,
        author: '赵乃吉',
        sec_user_id: NAIJI_SEC_USER_ID,
        message: '没有从 _ROUTER_DATA 中找到作品数据',
        source: shareUrl,
        html_length: html.length,
      });
    }

    /**
     * 去重
     */
    const unique = new Map<string, any>();

    for (const item of awemes) {
      if (
        item &&
        typeof item.aweme_id === 'string'
      ) {
        unique.set(item.aweme_id, item);
      }
    }

    const items = Array.from(unique.values());

    /**
     * 按发布时间倒序
     */
    items.sort((a, b) => {
      const timeA = Number(a.create_time || 0);
      const timeB = Number(b.create_time || 0);

      return timeB - timeA;
    });

    const latest = items[0];

    return successResponse({
      code: 200,
      author: '赵乃吉',
      sec_user_id: NAIJI_SEC_USER_ID,

      latest: {
        aweme_id: latest.aweme_id || '',
        desc: latest.desc || '',
        create_time: Number(
          latest.create_time || 0
        ),

        share_url:
          latest.aweme_id
            ? `https://www.douyin.com/video/${latest.aweme_id}`
            : '',

        author: {
          nickname:
            latest.author?.nickname || '赵乃吉',
          uid:
            latest.author?.uid ||
            latest.author?.sec_uid ||
            '',
        },

        statistics: {
          digg_count:
            Number(
              latest.statistics?.digg_count || 0
            ),

          comment_count:
            Number(
              latest.statistics?.comment_count || 0
            ),

          share_count:
            Number(
              latest.statistics?.share_count || 0
            ),

          collect_count:
            Number(
              latest.statistics?.collect_count || 0
            ),
        },
      },

      total_found: items.length,

      source: shareUrl,
    });
  } catch (error) {
    return successResponse({
      code: 500,
      author: '赵乃吉',
      sec_user_id: NAIJI_SEC_USER_ID,
      message:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}

/**
 * 从 HTML 中提取完整 JSON 对象
 *
 * 与 parser.ts 的思路一致，
 * 同时正确处理 JSON 字符串中的大括号。
 */
function extractJsonObject(
  html: string,
  startIndex: number
): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (
    let i = startIndex;
    i < html.length;
    i++
  ) {
    const c = html[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (c === '\\' && inString) {
      escape = true;
      continue;
    }

    if (c === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;

      if (depth === 0) {
        return html.substring(
          startIndex,
          i + 1
        );
      }
    }
  }

  return null;
}

/**
 * 递归寻找包含 aweme_id 的作品对象
 */
function findAwemeObjects(
  value: unknown,
  results: any[] = []
): any[] {
  if (!value || typeof value !== 'object') {
    return results;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      findAwemeObjects(item, results);
    }

    return results;
  }

  const obj = value as Record<string, any>;

  /**
   * 判断是否是作品对象
   */
  if (
    typeof obj.aweme_id === 'string' &&
    obj.aweme_id.length > 0 &&
    (
      obj.create_time !== undefined ||
      obj.desc !== undefined ||
      obj.video !== undefined
    )
  ) {
    results.push(obj);
  }

  for (const key of Object.keys(obj)) {
    findAwemeObjects(
      obj[key],
      results
    );
  }

  return results;
}
