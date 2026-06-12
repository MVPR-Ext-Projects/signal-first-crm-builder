interface WorkspaceSwitcherProps {
  workspaceId:   string
  workspaceName: string
}

export function WorkspaceSwitcher({
  workspaceName,
}: WorkspaceSwitcherProps) {
  return (
    <span className="shrink-0 text-[13px] font-medium text-white">
      {workspaceName}{" "}
      <span className="text-white/50 font-normal">- Signal First Dashboard</span>
    </span>
  )
}
