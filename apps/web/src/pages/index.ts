import type { Page } from '../layout.js';
import { developersPage } from './developers.js';
import { docPages, docsIndexPage } from './docs.js';
import { downloadPage } from './download.js';
import { featuresPage } from './features.js';
import { homePage } from './home.js';
import { changelogPage, notFoundPage, privacyPage, roadmapPage } from './other.js';

/** Every page of the site. Built on call so the base path from the environment applies. */
export function allPages(): Page[] {
  return [
    homePage(),
    downloadPage(),
    featuresPage(),
    developersPage(),
    docsIndexPage(),
    ...docPages(),
    changelogPage(),
    roadmapPage(),
    privacyPage(),
    notFoundPage(),
  ];
}
