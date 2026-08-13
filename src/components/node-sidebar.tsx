import {
  LinkBase,
  useDefaultTitle,
  useResourceDefinitions,
} from 'ra-core'
import { Shell } from 'lucide-react'

import { ResourceMenuItem } from '#/components/admin/app-sidebar'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '#/components/ui/sidebar'
import { FEATURE_CATALOG } from '#/lib/feature-catalog'

/**
 * Which resources belong together in the nav.
 *
 * Grouped by where they come from rather than by name: forms and submissions
 * both arrive with the forms feature and disappear with it, while settings and
 * features belong to the node itself and are always there. A flat list makes
 * those look like peers, which is misleading the moment a feature is switched
 * off and half the list vanishes.
 *
 * A feature's group is labelled from the catalog, so a new feature's resources
 * are grouped and named without touching this file.
 */
const NODE_GROUP = 'Node'

function groupFor(
  resource: string,
  definitions: ReturnType<typeof useResourceDefinitions>,
): string {
  // A resource may name its own group — the site's content collections do,
  // since they are discovered at runtime and belong to no feature.
  const declared = definitions[resource]?.options?.group
  if (typeof declared === 'string') return declared

  const feature = FEATURE_CATALOG.find((entry) =>
    entry.resources?.includes(resource),
  )
  return feature?.name ?? NODE_GROUP
}

export function NodeSidebar() {
  const resources = useResourceDefinitions()
  const title = useDefaultTitle()
  const { openMobile, setOpenMobile } = useSidebar()

  const close = () => {
    if (openMobile) setOpenMobile(false)
  }

  const listed = Object.keys(resources).filter((name) => resources[name].hasList)

  // Preserve registration order within a group, and keep the node's own
  // settings last — they are the least-used thing here.
  const groups = new Map<string, Array<string>>()
  for (const name of listed) {
    const group = groupFor(name, resources)
    groups.set(group, [...(groups.get(group) ?? []), name])
  }

  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === NODE_GROUP ? 1 : b === NODE_GROUP ? -1 : a.localeCompare(b),
  )

  return (
    <Sidebar variant="floating" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:!p-1.5"
            >
              <LinkBase to="/">
                <Shell className="!size-5" />
                <span className="text-base font-semibold">{title}</span>
              </LinkBase>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {ordered.map(([group, names]) => (
          <SidebarGroup key={group}>
            {/* Hidden when the sidebar collapses to icons, where a text label
                has nowhere to go. */}
            <SidebarGroupLabel>{group}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {names.map((name) => (
                  <ResourceMenuItem key={name} name={name} onClick={close} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter />
    </Sidebar>
  )
}
