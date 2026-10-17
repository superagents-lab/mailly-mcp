// 邮件正文 HTML → Markdown。
// 显式 .ts 扩展：node --experimental-strip-types 运行测试时不做扩展名解析
import {
  NodeHtmlMarkdown,
  type TranslatorConfig,
  type TranslatorConfigObject,
} from 'node-html-markdown';

/**
 * 译码器上下文里我们只用到属性读取。node-html-markdown 没有从包入口导出
 * TranslatorContext，这里按结构声明最小依赖，避免 import 它的 dist 内部路径。
 */
interface ElementLike {
  // node-html-parser 的返回类型在版本间在 null / undefined 之间摇摆，两者都要能接住
  getAttribute(name: string): string | null | undefined;
}

/**
 * 邮件 HTML 与网页 HTML 的关键差异是 <table>：邮件里绝大多数表格是布局骨架
 * 而不是数据表，按数据表转换会把整封邮件塌缩进一个单元格。这里统一按块级容器
 * 摊平——真·数据表因此也会摊成逐行文本，对邮件语料这是划算的取舍。
 */
const FLATTEN_TABLE: TranslatorConfig = { surroundingNewlines: 2 };

/** 完全丢弃元素及其子树。 */
const DROP: TranslatorConfig = { ignore: true, recurse: false };

/** 保持 node-html-markdown 的默认行为（块级/行内由 defaultBlockElements 决定）。 */
const KEEP: TranslatorConfig = {};

/** 营销邮件常用隐藏元素塞 preheader 文案，这些内容不该出现在正文里。 */
function isHidden(node: ElementLike): boolean {
  const style = node.getAttribute('style');
  if (style && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)) return true;
  return node.getAttribute('hidden') != null;
}

/** 宽或高标注为 0/1 的图片是追踪像素，不是内容。 */
function isTrackingPixel(node: ElementLike): boolean {
  const dimension = (name: string) => {
    const raw = node.getAttribute(name);
    if (raw == null) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const width = dimension('width');
  const height = dimension('height');
  return width != null && height != null && width <= 1 && height <= 1;
}

const emailTranslators: TranslatorConfigObject = {
  table: FLATTEN_TABLE,
  'td,th': FLATTEN_TABLE,
  // 必须完整覆写而不是委托默认译码器：translator 返回 undefined 不会回落到
  // 默认实现，而是直接把元素吞掉（会连正常图片一起丢失）。
  img: ({ node }: { node: ElementLike }): TranslatorConfig => {
    if (isHidden(node) || isTrackingPixel(node)) return DROP;
    const src = node.getAttribute('src') || '';
    // data: URI 内联图片动辄几十 KB，且对阅读没有帮助
    if (!src || /^data:/i.test(src)) return DROP;
    const alt = node.getAttribute('alt') || '';
    const title = node.getAttribute('title') || '';
    return { content: `![${alt}](${src}${title && ` "${title}"`})`, recurse: false };
  },
  'div,span,p,tr': ({ node }: { node: ElementLike }): TranslatorConfig => (
    isHidden(node) ? DROP : KEEP
  ),
};

// preferNativeParser 必须保持 false：它走 DOMParser，而 workerd 没有 DOM。
const emailMarkdown = new NodeHtmlMarkdown(
  { preferNativeParser: false, useInlineLinks: true },
  emailTranslators,
);

/**
 * 把一封邮件的 HTML 正文转成 Markdown。
 * 输入为空或转换结果为空白时返回 null，调用方据此回退到纯文本分段。
 */
export function emailHtmlToMarkdown(html: string | undefined | null): string | null {
  if (!html) return null;
  try {
    const markdown = emailMarkdown.translate(html).trim();
    return markdown || null;
  } catch (error) {
    console.error('[Inbox] HTML→Markdown 转换失败，回退到纯文本:', error);
    return null;
  }
}
