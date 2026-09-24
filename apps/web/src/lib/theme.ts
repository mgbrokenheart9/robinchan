/**
 * Theme constants shared by the root layout (server) and `<ThemeToggle>`
 * (client). Kept out of the `'use client'` module on purpose: a server
 * component importing a plain string from a client module gets a client
 * reference, not the string.
 */

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'robinchan-theme';

/** Browser chrome color per theme — mirrors `--c-bg` in globals.css. */
export const THEME_COLOR: Record<Theme, string> = { light: '#F8FAF6', dark: '#0A0A0A' };

/**
 * Runs in <head> before first paint so a returning dark-mode visitor never
 * sees a light flash. Light is the default: the OS preference is ignored
 * until the visitor picks a theme themselves.
 */
export const THEME_INIT_SCRIPT = `(function(){try{if(localStorage.getItem('${THEME_STORAGE_KEY}')==='dark'){document.documentElement.classList.add('dark');var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content','${THEME_COLOR.dark}')}}catch(e){}})()`;
