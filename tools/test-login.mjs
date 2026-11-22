// 登录层的单测：cookie 解析 + 前置校验，不联网、不碰真实账号。
// 跑法：node tools/test-login.mjs
import { parseCookieString, loginWithCookies } from '../lib/auth.js';

let pass = 0;
const fails = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// ---------- parseCookieString ----------
{
  const j = parseCookieString('__client=abc; __client_uat=123');
  check('解析出 __client', j.__client === 'abc', JSON.stringify(j));
  check('解析出 __client_uat', j.__client_uat === '123');
}

{
  // base64 / jwt 里会带 =，不能被截断
  const j = parseCookieString('__client=eyJhbGciOi.eyJzdWIiOiJ1In0.sig==');
  check('值里的 = 保留', j.__client === 'eyJhbGciOi.eyJzdWIiOiJ1In0.sig==', j.__client);
}

{
  const j = parseCookieString('  __client = "quoted" ;  other=x  ');
  check('去掉名字两侧空格', j.__client === 'quoted', JSON.stringify(j));
  check('去掉值两侧引号', j.__client === 'quoted');
  check('同串里的其它 cookie 也认', j.other === 'x');
}

{
  const j = parseCookieString('__client=; __client_uat=1');
  check('空值不算 cookie', !('__client' in j), JSON.stringify(j));
}

{
  const j = parseCookieString('');
  check('空串返回空对象', Object.keys(j).length === 0);
  check('null 也安全', Object.keys(parseCookieString(null)).length === 0);
}

// ---------- loginWithCookies：没有 __client 时必须在联网前就拒绝 ----------
{
  let err = null;
  try {
    await loginWithCookies({});
  } catch (e) {
    err = e;
  }
  check('缺 __client 直接报错', Boolean(err));
  check('错误码是 no_client_cookie', err?.code === 'no_client_cookie', err?.code);
  check('错误信息可读', /__client/.test(err?.message || ''), err?.message);
}

{
  let err = null;
  try {
    await loginWithCookies(null);
  } catch (e) {
    err = e;
  }
  check('传 null 也拒绝', err?.code === 'no_client_cookie', err?.code);
}

console.log('');
console.log(`${pass}/${pass + fails.length} 通过`);
if (fails.length) process.exit(1);
