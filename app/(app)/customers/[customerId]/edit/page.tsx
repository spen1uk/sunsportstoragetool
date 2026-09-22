import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile, canManage } from "@/lib/utils/current-profile";
import { CustomerForm } from "@/components/customers/customer-form";
import { updateCustomer } from "@/lib/actions/customers";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function EditCustomerPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await params;
  const profile = await getCurrentProfile();
  if (!profile || !canManage(profile.role)) {
    redirect(`/customers/${customerId}`);
  }

  const supabase = await createClient();
  const { data: customer } = await supabase.from("customers").select("*").eq("id", customerId).single();
  if (!customer) notFound();

  const action = updateCustomer.bind(null, customerId);

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Edit {customer.first_name} {customer.last_name}
        </h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Customer Information</CardTitle>
        </CardHeader>
        <CardContent>
          <CustomerForm customer={customer} action={action} />
        </CardContent>
      </Card>
    </div>
  );
}
