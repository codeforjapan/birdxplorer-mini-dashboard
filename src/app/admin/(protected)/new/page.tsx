import { requireAdminOrRedirect } from "@/lib/admin/session";
import { NewTenantWizard } from "./NewTenantWizard";

export const dynamic = "force-dynamic";

export default async function NewTenantPage() {
  await requireAdminOrRedirect();
  return (
    <main>
      <NewTenantWizard />
    </main>
  );
}
