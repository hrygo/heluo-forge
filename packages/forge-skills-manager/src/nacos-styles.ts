export const nacosCss = `
.dssm-nacos{display:flex;flex-direction:column;gap:14px;min-width:0;container-type:inline-size}
.dssm-nacos-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dssm-nacos-heading h3{margin:0;font-size:16px;line-height:24px;font-weight:600}
.dssm-nacos-subtitle{margin:3px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dssm-nacos-tools{display:flex;align-items:center;gap:8px;min-width:0}
.dssm-nacos-search{flex:1;min-width:0;display:flex;align-items:center;gap:6px}
.dssm-nacos-search>span,.dssm-nacos-search>div{flex:1;min-width:0}
.dssm-nacos-search input{box-sizing:border-box;width:100%;min-width:0;font-size:13px}
.dssm-nacos-tools button{flex:none}
.dssm-nacos-count,.dssm-nacos-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dssm-nacos-count{margin:0;min-height:18px}
.dssm-nacos-summary{display:flex;align-items:baseline;justify-content:space-between;gap:6px 12px;flex-wrap:wrap}
.dssm-nacos-sort{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dssm-nacos-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;min-width:0}
.dssm-nacos-card{box-sizing:border-box;display:flex;flex-direction:column;gap:9px;min-width:0;padding:14px 16px;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2));border:0.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-xl,16px);transition:border-color .15s ease}
.dssm-nacos-card:hover{border-color:var(--dsw-alias-border-l3)}
.dssm-nacos-card-head{display:flex;align-items:flex-start;gap:10px;min-width:0}
.dssm-nacos-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-1)}
.dssm-nacos-card h4{flex:1;min-width:0;margin:3px 0 0;font-size:14px;line-height:21px;font-weight:600;overflow-wrap:anywhere}
.dssm-nacos-version{display:inline-flex;align-items:center;flex:none;max-width:100%;padding:1px 6px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xs,4px);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;overflow-wrap:anywhere}
.dssm-nacos-card-head .dssm-nacos-version{max-width:35%;margin-top:4px}
.dssm-nacos-description{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.dssm-nacos-installations{display:flex;flex-wrap:wrap;gap:4px 8px;min-width:0}
.dssm-nacos-installation{margin:0;padding:2px 7px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xs,4px);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);overflow-wrap:anywhere}
.dssm-nacos-card-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px 12px;flex-wrap:wrap;margin-top:auto}
.dssm-nacos-card-actions>button{flex:none;margin-left:auto}
.dssm-nacos-meta{display:flex;align-items:center;gap:12px;flex:1 1 180px;min-width:0;min-height:18px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dssm-nacos-namespace,.dssm-nacos-downloads{display:inline-flex;align-items:center;gap:4px;min-width:0}
.dssm-nacos-namespace{max-width:160px;flex:0 1 auto}
.dssm-nacos-namespace>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dssm-nacos-downloads,.dssm-nacos-meta svg{flex:none}
.dssm-nacos-pagination{display:flex;justify-content:center;align-items:center;gap:12px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dssm-nacos-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:28px 16px;text-align:center;border:0.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl,16px);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:21px;overflow-wrap:anywhere}
.dssm-nacos-state strong{font-size:14px;color:var(--dsw-alias-label-primary)}
.dssm-nacos-state p{margin:0}
.dssm-nacos-notice{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;overflow-wrap:anywhere}
.dssm-nacos-notice.is-error{color:var(--dsw-alias-state-error-primary)}
.dssm-nacos-notice.is-warning{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}
.dssm-nacos-notice button{flex:none}
.dssm-nacos-skeleton{pointer-events:none;min-height:120px}
.dssm-nacos-skeleton span{display:block;height:12px;border-radius:4px;background:var(--dsw-alias-border-l1)}
.dssm-nacos-skeleton span:first-child{width:58%;height:16px;margin-bottom:8px}
.dssm-nacos-skeleton span:last-child{width:72%}
.dssm-modal.dssm-nacos-dialog{width:640px!important;max-width:calc(100vw - 32px)!important;max-height:calc(100dvh - 32px)!important;min-width:0;box-sizing:border-box;display:flex;flex-direction:column}
.dssm-nacos-dialog-content{display:flex;flex-direction:column;min-height:0;overflow:hidden!important;flex:1}
.dssm-nacos-dialog-content>div{min-width:0}
.dssm-nacos-dialog-content>[class*="header"]{min-width:0;flex:none}
.dssm-nacos-dialog-content>[class*="body"]{min-height:0;overflow:auto;overscroll-behavior:contain;flex:1}
.dssm-nacos-dialog>[class*="footer"]{flex:none}
.dssm-nacos-dialog [class*="title"]{overflow-wrap:anywhere;white-space:normal}
.dssm-nacos-detail{display:flex;flex-direction:column;gap:18px;min-width:0;color:var(--dsw-alias-label-primary)}
.dssm-nacos-overview{display:flex;flex-direction:column;align-items:flex-start;gap:8px}
.dssm-nacos-overview p{margin:0;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dssm-nacos-markdown{font-size:13px;line-height:1.7;overflow-wrap:anywhere;min-width:0}
.dssm-nacos-markdown>:first-child{margin-top:0}.dssm-nacos-markdown>:last-child{margin-bottom:0}
.dssm-nacos-markdown :is(h1,h2,h3,h4,h5,h6){font-weight:600;line-height:1.45;margin:20px 0 8px}
.dssm-nacos-markdown h1{font-size:20px}.dssm-nacos-markdown h2{font-size:17px}.dssm-nacos-markdown h3{font-size:15px}
.dssm-nacos-markdown :is(p,ul,ol,pre,blockquote){margin:8px 0}
.dssm-nacos-markdown :is(ul,ol){padding-left:22px}.dssm-nacos-markdown li+li{margin-top:4px}
.dssm-nacos-markdown code,.dssm-nacos-resources code,.dssm-nacos-path code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.dssm-nacos-markdown :not(pre)>code{padding:2px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-1)}
.dssm-nacos-markdown pre{overflow:auto;max-width:100%;padding:12px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);white-space:pre;box-sizing:border-box}
.dssm-nacos-markdown blockquote{margin-left:0;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dssm-nacos-markdown a{color:var(--dsw-alias-state-business-primary);text-decoration:underline}
.dssm-nacos-table{max-width:100%;overflow:auto}.dssm-nacos-table table{border-collapse:collapse;font-size:12px}
.dssm-nacos-table :is(th,td){padding:6px 10px;border:0.5px solid var(--dsw-alias-border-l2);text-align:left}
.dssm-nacos-resources,.dssm-nacos-path{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dssm-nacos-resources summary,.dssm-nacos-path summary{cursor:pointer;width:fit-content}
.dssm-nacos-resources ul{margin:8px 0 0;padding-left:20px;max-height:160px;overflow:auto}
.dssm-nacos-resources code,.dssm-nacos-path code{overflow-wrap:anywhere;white-space:pre-wrap}
.dssm-nacos-path code{display:block;margin-top:6px}
.dssm-nacos-destination{display:flex;flex-direction:column;gap:10px;border-top:0.5px solid var(--dsw-alias-border-l1);padding-top:16px}
.dssm-nacos-destination h3{margin:0;font-size:14px;font-weight:600}
.dssm-nacos-scope,.dssm-nacos-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dssm-nacos-project{display:flex;flex-direction:column;gap:6px}.dssm-nacos-project>span{align-self:flex-start}
.dssm-nacos-project>span:has(button){align-self:stretch;max-width:100%}
.dssm-nacos-project .dssm-menu-select-trigger{width:100%;max-width:100%;box-sizing:border-box}
.dssm-nacos-note{margin:0}
.dssm-nacos-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;width:100%}
.dssm-nacos-footer .dssm-nacos-actions{margin-left:auto}
.dssm-nacos :is(button,summary):focus-visible,.dssm-nacos-dialog :is(a,button,summary):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px}
@container (min-width:640px){.dssm-nacos-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dssm-nacos-card{min-height:154px}}
@media(max-width:480px){.dssm-nacos-notice{align-items:flex-start;flex-direction:column}.dssm-nacos-tools{gap:6px}.dssm-nacos-card{padding:12px}.dssm-nacos-card-head{flex-wrap:wrap}.dssm-nacos-card-head h4{flex-basis:calc(100% - 42px)}.dssm-nacos-card-head .dssm-nacos-version{margin:0 0 0 40px;max-width:calc(100% - 40px)}}
@media(prefers-reduced-motion:reduce){.dssm-nacos-card{transition:none}}
`;
