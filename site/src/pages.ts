import { useRouter } from '@tanstack/react-router'

// 06-UI-SPEC Navigation. A link shows only once its route file exists, so the crawl never meets a missing page
// and later plans add pages without editing this list.
export const MAIN_NAV = [['Findings', '/findings/checks'], ['Selection', '/prisma'], ['Validation', '/validation'], ['Methods', '/methods'], ['Review', '/review']] as const
export const FINDINGS_NAV = [['Checks', '/findings/checks'], ['Decisions', '/findings/decisions'], ['Cohorts', '/findings/cohorts'], ['Sources', '/findings/sources'], ['Claims', '/findings/claims'], ['Source types', '/findings/source-types']] as const

export function useExisting<T extends readonly (readonly [string, string])[]>(links: T) {
  const { routesByPath } = useRouter()
  return links.filter(([, path]) => path in routesByPath)
}
