export const automaticExpressionPolicy=Object.freeze({version:'action-timing-v1',actionRetime:true,transitions:false,colorGrade:false,abruptZoom:false});
export function expressionOptions(options={}){return {allowRemap:options.actionRetime!==false,allowTransitions:options.expressiveTransitions===true};}
