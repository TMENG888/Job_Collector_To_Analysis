// UTF-8 JSON 请求体构造：Node fetch/undici 在 body 为字符串且 Content-Type 未声明 charset 时按
// Latin-1 编码，任何含中文（关键词、城市名）的 JSON 都会被逐字节破坏，服务端解码后得到乱码，
// 表现为「验证即停 / 非有效 JSON」。统一改为 UTF-8 字节流并显式声明 charset，从根上消除该失败面。
const encoder = new TextEncoder();

export function jsonBodyBytes(value) {
  return encoder.encode(typeof value === 'string' ? value : JSON.stringify(value));
}

export function jsonRequestBody(payload, headers = {}) {
  return {
    // 调用方显式给出的 content-type 优先；缺省时才补上带 charset 的 JSON 类型。
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: jsonBodyBytes(payload),
  };
}