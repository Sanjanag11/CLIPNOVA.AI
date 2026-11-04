import MainLiveScreen from "../_live/MainLive";

const PLANS = ["free", "creator", "pro"];

/** Demo-only query params: ?plan=free|creator|pro and ?region=DE (to try plan limits and licence territories). */
export default async function Page({ searchParams }: { searchParams: Promise<{ plan?: string; region?: string }> }) {
  const q = await searchParams;
  const plan = q.plan && PLANS.includes(q.plan) ? q.plan : "free";
  const region = q.region && /^[A-Za-z]{2}$/.test(q.region) ? q.region.toUpperCase() : undefined;
  return <MainLiveScreen plan={plan} region={region} />;
}
