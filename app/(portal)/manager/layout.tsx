import { PortalFrame } from '@/components/portal/PortalFrame';

export default function Layout({ children }: LayoutProps<'/manager'>) {
  return <PortalFrame roles={['sub_manager']}>{children}</PortalFrame>;
}
