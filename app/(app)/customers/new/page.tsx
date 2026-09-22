import { redirect } from "next/navigation";
import { CustomerForm } from "@/components/customers/customer-form";
import { createCustomer } from "@/lib/actions/customers";
import { getCurrentProfile, canManage } from "@/lib/utils/current-profile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function NewCustomerPage() {
  const profile = await getCurrentProfile();
  if (!profile || !canManage(profile.role)) {
    redirect("/customers");
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New Customer</h1>
        <p className="text-sm text-muted-foreground">Add a customer before assigning them a boat.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Customer Information</CardTitle>
        </CardHeader>
        <CardContent>
          <CustomerForm action={createCustomer} />
        </CardContent>
      </Card>
    </div>
  );
}
