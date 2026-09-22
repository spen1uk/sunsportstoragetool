import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function ScanRedirectPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = await createClient();

  const { data: unit } = await supabase.from("units").select("id").eq("qr_token", token).single();

  if (!unit) notFound();

  redirect(`/units/${unit.id}`);
}
