import type { Metadata } from 'next'

import { PrintPrepTool } from './PrintPrepTool'

export const metadata: Metadata = {
  title: 'Button print prep',
  robots: { index: false, follow: false },
}

export default function PrintPrepPage() {
  return <PrintPrepTool />
}
