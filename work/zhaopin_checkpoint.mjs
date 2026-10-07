export function zhaopinCheckpoint(current) {
  const records=[...current.records.values()];
  const totalReached=current.total>0&&records.length>=current.total;
  return {keyword:current.keyword,city:current.city,total:current.total,complete:Boolean(current.validResponse && (current.explicitEmpty||current.endPage||totalReached)),
    end_page:Boolean(current.validResponse&&current.endPage),completion_reason:current.explicitEmpty?'confirmed_empty':current.validResponse&&current.endPage?'end_page':current.validResponse&&totalReached?'total_reached':'in_progress',
    last_page_index:current.lastPageIndex,collected_at:new Date().toISOString(),records};
}
