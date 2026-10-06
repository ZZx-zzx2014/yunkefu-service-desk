/**
 * 路径归一化工具（供 check-consistency.js 使用）
 *
 * 注意：不能用 String.replace(/\$\{/g, '\u0000{') 来标记插值起点 ——
 * 替换串中的 `$'` 在 replace 里有特殊含义（插入「匹配位置之后的所有内容」），
 * 会静默吞掉路径尾部。此处改为纯逐字符扫描，避免该陷阱。
 */

/** 把模板字符串路径中的 ${...} 归一化为 :id（路径参数）或删除（查询串拼接） */
export function stripInterpolations(input) {
  const s = String(input);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '$' && s[i + 1] === '{') {
      // 用花括号配对跳过整个插值表达式（支持对象字面量等嵌套）
      let depth = 0;
      i += 2; // 跳过 "${"
      while (i < s.length) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') {
          if (depth === 0) break;
          depth--;
        }
        i++;
      }
      // 插值紧跟在 '/' 之后 → 路径参数；否则多为查询串拼接，直接丢弃
      if (out.endsWith('/')) out += ':id';
      continue;
    }
    out += s[i];
  }
  return out;
}

/** 归一化为可比较的接口路径 */
export function normalizePath(p) {
  return stripInterpolations(p).split('?')[0].replace(/\/+$/, '');
}

/* 自检：确保关键形态归一化正确 */
if (process.argv[1] && process.argv[1].endsWith('normalize-path.js')) {
  const cases = [
    ['/api/conversations/${currentConv.id}/messages', '/api/conversations/:id/messages'],
    ['/api/tickets/${ticket.id}/comments', '/api/tickets/:id/comments'],
    ['/api/kb/articles/${item.dataset.kb}', '/api/kb/articles/:id'],
    ['/api/tickets${Kefu.qs({ page: 1, pageSize: 15, scope })}', '/api/tickets'],
    ['/api/admin/users/${u.id}', '/api/admin/users/:id'],
    ['/api/conversations/upload', '/api/conversations/upload'],
    ['/api/kb/articles/${newArt.payload.id}/feedback', '/api/kb/articles/:id/feedback'],
  ];
  let bad = 0;
  for (const [input, want] of cases) {
    const got = normalizePath(input);
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} ${input}\n    => ${got}${ok ? '' : `  (期望 ${want})`}`);
  }
  console.log(bad === 0 ? '\n全部归一化用例通过' : `\n${bad} 个用例失败`);
  process.exitCode = bad === 0 ? 0 : 1;
}
