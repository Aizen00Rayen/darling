import { PortalFrame } from '@/components/portal/PortalFrame';

export default function Layout({ children }: LayoutProps<'/affiliate'>) {
  return <PortalFrame roles={['affiliate']}>{children}</PortalFrame>;
}
