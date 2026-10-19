export const isCollectionStage=stage=>['public','zhaopin','boss','yupao'].includes(stage);
export const shouldStopAtTarget=({stage,status,valid,target})=>Number.isSafeInteger(target)&&target>0&&isCollectionStage(stage)&&status==='running'&&valid>=target;
