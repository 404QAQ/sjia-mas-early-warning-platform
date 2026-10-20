/**
 * 公开源码入口。
 *
 * 患者端构建和包 exports 都使用 public-index；这里保留同一入口，避免
 * 从源码路径意外拿到公开契约之外的实现。
 */
export * from './public-index.js';
