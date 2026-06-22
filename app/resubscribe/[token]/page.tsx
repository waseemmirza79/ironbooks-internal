import { ConsentAction } from "@/components/ConsentAction";

export const dynamic = "force-dynamic";

export default async function ResubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F4F9F8", fontFamily: "Arial, Helvetica, sans-serif", padding: 24 }}>
      <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 20, padding: 40, maxWidth: 460, textAlign: "center" }}>
        <h1 style={{ color: "#0F1F2E", fontSize: 22, marginBottom: 10 }}>Resubscribe to Ironbooks updates?</h1>
        <p style={{ color: "#475569", fontSize: 15, lineHeight: 1.6, marginBottom: 24 }}>
          We'll start sending you our updates and tips again. You can unsubscribe anytime.
        </p>
        <ConsentAction token={token} action="resubscribe" />
      </div>
    </main>
  );
}
