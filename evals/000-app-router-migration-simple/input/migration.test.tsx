import { expect, test } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

test('App Router migration completed successfully', () => {
  const rootDir = process.cwd();
  
  // 1. App directory should exist
  const appDir = join(rootDir, 'app');
  expect(existsSync(appDir)).toBe(true);
  
  // 2. App Router files should exist
  const layoutPath = join(appDir, 'layout.tsx');
  const pagePath = join(appDir, 'page.tsx');
  
  expect(existsSync(layoutPath)).toBe(true);
  expect(existsSync(pagePath)).toBe(true);
});

test('App layout.tsx has proper structure', () => {
  const rootDir = process.cwd();
  const layoutPath = join(rootDir, 'app', 'layout.tsx');
  
  if (existsSync(layoutPath)) {
    const layoutContent = readFileSync(layoutPath, 'utf-8');
    
    // Should export default function
    expect(layoutContent).toMatch(/export\s+default\s+function/);
    
    // Should have children prop
    expect(layoutContent).toMatch(/children/);
    
    // Should have html and body tags
    expect(layoutContent).toMatch(/<html/);
    expect(layoutContent).toMatch(/<body/);
    
    // Should have proper metadata setup
    expect(layoutContent).toMatch(/title|metadata/i);
  }
});

test('App page.tsx migrated correctly', () => {
  const rootDir = process.cwd();
  const pagePath = join(rootDir, 'app', 'page.tsx');
  
  if (existsSync(pagePath)) {
    const pageContent = readFileSync(pagePath, 'utf-8');
    
    // Should export default function
    expect(pageContent).toMatch(/export\s+default\s+function/);
    
    // Should have the main content (Home heading)
    expect(pageContent).toMatch(/Home/);
    
    // Should NOT have Next/Head imports (App Router uses layout)
    expect(pageContent).not.toMatch(/import.*Head.*from.*next\/head/);
  }
});

test('Pages directory is removed or cleaned up', () => {
  const rootDir = process.cwd();
  const pagesDir = join(rootDir, 'pages');
  
  if (existsSync(pagesDir)) {
    const pagesContents = readdirSync(pagesDir);
    
    // Pages directory should be empty or only contain API routes
    const nonApiFiles = pagesContents.filter(file => 
      !file.startsWith('api') && 
      !file.startsWith('_') && 
      file.endsWith('.tsx')
    );
    
    expect(nonApiFiles.length).toBe(0);
  }
});

test('Navigation uses App Router patterns', () => {
  const rootDir = process.cwd();
  const pagePath = join(rootDir, 'app', 'page.tsx');
  
  if (existsSync(pagePath)) {
    const pageContent = readFileSync(pagePath, 'utf-8');
    
    // Should use Link component instead of anchor tags for internal navigation
    if (pageContent.includes('href="/')) {
      expect(pageContent).toMatch(/import.*Link.*from.*next\/link/);
    }
  }
});