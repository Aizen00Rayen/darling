import { PortalFrame } from '@/components/portal/PortalFrame';

export default function Layout({ children }: LayoutProps<'/admin'>) {
  return <PortalFrame roles={['super_manager']}>{children}</PortalFrame>;
}
