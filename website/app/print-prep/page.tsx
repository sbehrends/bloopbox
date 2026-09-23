import type { Metadata } from 'next'

import { PrintPrepTool } from './PrintPrepTool'

// Hidden utility page: not linked from the site, not indexed. Direct link only.
export const metadata: Metadata = {
  title: 'Button print prep',
  robots: { index: false, follow: false },
}

export default function PrintPrepPage() {
  return <PrintPrepTool />
}
