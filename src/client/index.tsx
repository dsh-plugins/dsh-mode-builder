/**
 * 浏览器端入口：注册「模式管理」自定义配置面板。
 *
 * 配置模板与操作由宿主声明（`src/index.ts`），这里只提供渲染与本地化。
 */
import * as React from 'react';
import type { ConfigPanelProps, DshLoaderUi } from '@dsh-plugin/dsh-loader/client';
import { en, zh, type ModeBuilderKey } from './locales.js';
import { ModesPanel, TranslatorContext, type Translator } from './modes-panel.js';

/** 浏览器端 Cordis 服务名：面板依赖 loader UI；本地化服务按需读取。 */
export const inject = ['dshLoaderUi'];

/** 配置模板标识，必须与宿主端声明一致。 */
const CONFIG_ID = 'dsh-mode-builder';

/** 本地化服务的客户端接口（宿主由 `@deepseek-ai/dsh-client-locale` 提供）。 */
interface LocaleService {
  register(id: string, dictionaries: Readonly<Record<string, Readonly<Record<string, string>>>>): () => void;
  bind(id: string): (key: ModeBuilderKey) => string;
}

/** 客户端插件上下文的最小形状。 */
interface ClientContext {
  effect(fn: () => void | (() => void)): unknown;
  /** Cordis 服务读取；本地化插件未挂载时返回 undefined。 */
  get?(name: string): unknown;
  dshLoaderUi: Pick<DshLoaderUi, 'config'>;
}

/**
 * 注册管理面板；字典缺失时退回内置中文，保证面板始终可读。
 * @param ctx 浏览器端插件上下文。
 */
export function apply(ctx: ClientContext): void {
  const locale = ctx.get?.('locale') as LocaleService | undefined;

  ctx.effect(() => {
    if (locale === undefined) return undefined;
    return locale.register(CONFIG_ID, { zh, en });
  });

  const t: Translator = (key, vars) => {
    let template: string = zh[key];
    if (locale !== undefined) {
      try {
        const localized = locale.bind(CONFIG_ID)(key);
        template = localized.length > 0 ? String(localized) : zh[key];
      } catch {
        template = zh[key];
      }
    }
    if (vars === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = vars[name];
      return value === undefined ? match : String(value);
    });
  };

  const register = ctx.dshLoaderUi.config.registerPanel.bind(ctx.dshLoaderUi.config);
  const owner = ctx as unknown as Parameters<typeof register>[0];

  ctx.effect(() => register(owner, {
    id: 'modes',
    configId: CONFIG_ID,
    component: (props: ConfigPanelProps) => (
      <TranslatorContext.Provider value={t}>
        <ModesPanel {...props} />
      </TranslatorContext.Provider>
    ),
  }));
}
