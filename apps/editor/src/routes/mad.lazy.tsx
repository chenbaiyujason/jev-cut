import { createLazyFileRoute } from '@tanstack/react-router'
import { MadStudio } from '@/features/mad-studio/mad-studio'
export const Route = createLazyFileRoute('/mad')({ component: MadStudio })
