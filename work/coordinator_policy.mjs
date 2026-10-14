export const isCollectionStage=stage=>['public','zhaopin','boss','yupao'].includes(stage);
export const shouldStopAtTarget=({stage,status,valid,target})=>isCollectionStage(stage)&&status==='running'&&valid>=target;
