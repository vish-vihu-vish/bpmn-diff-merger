declare module 'bpmn-moddle' {
  export default class BpmnModdle {
    fromXML(xml: string): Promise<{ rootElement: any }>;
  }
}

declare module 'bpmn-js-differ' {
  export function diff(left: any, right: any): unknown;
}

declare module 'diagram-js/lib/navigation/movecanvas' {
  const value: any;
  export default value;
}

declare module 'diagram-js/lib/navigation/zoomscroll' {
  const value: any;
  export default value;
}
