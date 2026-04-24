import { useEffect, useRef } from 'react';
import BpmnViewer from 'bpmn-js/lib/Viewer';
import MoveCanvasModule from 'diagram-js/lib/navigation/movecanvas';
import ZoomScrollModule from 'diagram-js/lib/navigation/zoomscroll';

type CanvasLike = {
  zoom(newZoom?: number | string, center?: string): number | void;
  viewbox(box?: { x: number; y: number; width: number; height: number }): ViewboxLike;
  addMarker(element: unknown, marker: string): void;
  removeMarker(element: unknown, marker: string): void;
};

type ElementRegistryLike = {
  getAll(): DiagramElement[];
  get(id: string): DiagramElement | undefined;
};

type EventBusLike = {
  on(event: string, callback: (event: { element?: { id?: string } }) => void): void;
};

type Props = {
  xml: string;
  activeElementId?: string | null;
  focusRequest?: { id: string; nonce: number } | null;
  title: string;
  markers: Record<string, string[]>;
  onElementClick?: (id: string) => void;
};

type DiagramElement = {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  waypoints?: Array<{ x: number; y: number }>;
};

type ViewboxLike = {
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
};

const MARKER_CLASSES = [
  'merge-active',
  'merge-added',
  'merge-removed',
  'merge-changed',
  'merge-focus',
  'merge-pulse',
  'merge-excluded',
  'merge-from-choice',
  'merge-mixed-choice'
];

export default function DiagramViewer({
  xml,
  activeElementId,
  focusRequest,
  title,
  markers,
  onElementClick
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<BpmnViewer | null>(null);
  const clickHandlerRef = useRef(onElementClick);
  const hasRenderedRef = useRef(false);
  const previousViewboxRef = useRef<ViewboxLike | null>(null);
  const focusRequestRef = useRef(focusRequest);

  clickHandlerRef.current = onElementClick;
  focusRequestRef.current = focusRequest;

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const viewer = new BpmnViewer({
      container: containerRef.current,
      additionalModules: [MoveCanvasModule, ZoomScrollModule]
    });

    const eventBus = viewer.get('eventBus') as EventBusLike;
    eventBus.on('element.click', (event) => {
      const id = event.element?.id;
      if (id) {
        pulseElement(viewer, id);
        clickHandlerRef.current?.(id);
      }
    });

    viewerRef.current = viewer;

    return () => {
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      if (!viewerRef.current) {
        return;
      }

      try {
        const existingCanvas = viewerRef.current.get('canvas') as CanvasLike;
        if (hasRenderedRef.current) {
          previousViewboxRef.current = existingCanvas.viewbox();
        }

        await viewerRef.current.importXML(xml);
        if (cancelled) {
          return;
        }

        const canvas = viewerRef.current.get('canvas') as CanvasLike;
        const elementRegistry = viewerRef.current.get('elementRegistry') as ElementRegistryLike;

        if (previousViewboxRef.current) {
          const { x, y, width, height } = previousViewboxRef.current;
          canvas.viewbox({ x, y, width, height });
        } else {
          canvas.zoom('fit-viewport', 'auto');
        }

        applyMarkers(canvas, elementRegistry, markers, activeElementId);

        const pendingFocus = focusRequestRef.current;
        if (pendingFocus) {
          const pendingElement = elementRegistry.get(pendingFocus.id);
          if (pendingElement) {
            focusElement(canvas, pendingElement);
            canvas.addMarker(pendingElement, 'merge-focus');

            window.setTimeout(() => {
              canvas.removeMarker(pendingElement, 'merge-focus');
            }, 1800);
          }
        }

        hasRenderedRef.current = true;
      } catch (error) {
        console.error(`Failed to render ${title}`, error);
      }
    }

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [title, xml]);

  useEffect(() => {
    if (!viewerRef.current) {
      return;
    }

    const canvas = viewerRef.current.get('canvas') as CanvasLike;
    const elementRegistry = viewerRef.current.get('elementRegistry') as ElementRegistryLike;
    applyMarkers(canvas, elementRegistry, markers, activeElementId);
  }, [activeElementId, markers]);

  useEffect(() => {
    if (!viewerRef.current || !focusRequest) {
      return;
    }

    const canvas = viewerRef.current.get('canvas') as CanvasLike;
    const elementRegistry = viewerRef.current.get('elementRegistry') as ElementRegistryLike;
    const element = elementRegistry.get(focusRequest.id);

    if (!element) {
      return;
    }

    focusElement(canvas, element);
    canvas.addMarker(element, 'merge-focus');
    pulseElement(viewerRef.current, focusRequest.id);

    const timeout = window.setTimeout(() => {
      canvas.removeMarker(element, 'merge-focus');
    }, 1800);

    return () => {
      window.clearTimeout(timeout);
      canvas.removeMarker(element, 'merge-focus');
    };
  }, [focusRequest]);

  function zoomBy(factor: number) {
    if (!viewerRef.current) {
      return;
    }

    const canvas = viewerRef.current.get('canvas') as CanvasLike;
    const currentZoom = Number(canvas.zoom() || 1);
    canvas.zoom(Math.max(0.2, Math.min(4, currentZoom * factor)), 'auto');
  }

  function fitViewport() {
    if (!viewerRef.current) {
      return;
    }

    const canvas = viewerRef.current.get('canvas') as CanvasLike;
    canvas.zoom('fit-viewport', 'auto');
  }

  return (
    <section className="viewer-card">
      <header className="viewer-header">
        <h3>{title}</h3>
        <div className="viewer-tools">
          <button type="button" onClick={() => zoomBy(1.2)}>
            +
          </button>
          <button type="button" onClick={() => zoomBy(1 / 1.2)}>
            -
          </button>
          <button type="button" onClick={fitViewport}>
            Fit
          </button>
        </div>
      </header>
      <div className="viewer-surface workflow-surface" ref={containerRef} />
      <div className="viewer-footer">Drag empty canvas to pan. Scroll or use +/- to zoom.</div>
    </section>
  );
}

function focusElement(canvas: CanvasLike, element: DiagramElement) {
  const bounds = getElementBounds(element);
  if (!bounds) {
    canvas.zoom('fit-viewport', 'auto');
    return;
  }

  const viewbox = canvas.viewbox();
  const scale = viewbox.scale ?? Number(canvas.zoom() || 1);
  const margin = 48 / Math.max(scale, 0.01);
  const isVisibleEnough =
    bounds.x >= viewbox.x + margin &&
    bounds.y >= viewbox.y + margin &&
    bounds.x + bounds.width <= viewbox.x + viewbox.width - margin &&
    bounds.y + bounds.height <= viewbox.y + viewbox.height - margin;
  const renderedWidth = bounds.width * scale;
  const renderedHeight = bounds.height * scale;
  const targetMinWidth = 260;
  const targetMinHeight = 120;
  const isBigEnough = renderedWidth >= targetMinWidth && renderedHeight >= targetMinHeight;

  if (isVisibleEnough && isBigEnough) {
    return;
  }

  const viewerElement = document.querySelector('.workflow-surface') as HTMLElement | null;
  const availableWidth = viewerElement?.clientWidth ?? window.innerWidth * 0.52;
  const availableHeight = viewerElement?.clientHeight ?? window.innerHeight * 0.48;
  const targetOccupancy = 0.75;
  const viewportWidth = availableWidth;
  const viewportHeight = availableHeight;
  const widthScale = (viewportWidth * targetOccupancy) / Math.max(bounds.width, 1);
  const heightScale = (viewportHeight * targetOccupancy) / Math.max(bounds.height, 1);
  const desiredScale = Math.max(0.35, Math.min(3.5, widthScale, heightScale));
  const finalScale = isBigEnough && !isVisibleEnough ? scale : Math.max(scale, desiredScale);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const targetWidth = viewportWidth / finalScale;
  const targetHeight = viewportHeight / finalScale;
  const padding = 36 / finalScale;

  canvas.viewbox({
    x: centerX - targetWidth / 2 - padding,
    y: centerY - targetHeight / 2 - padding,
    width: targetWidth + padding * 2,
    height: targetHeight + padding * 2
  });
}

function getElementBounds(element: DiagramElement) {
  if (typeof element.x === 'number' && typeof element.y === 'number') {
    return {
      x: element.x,
      y: element.y,
      width: element.width ?? 80,
      height: element.height ?? 80
    };
  }

  if (element.waypoints?.length) {
    const xs = element.waypoints.map((point) => point.x);
    const ys = element.waypoints.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    return {
      x: minX,
      y: minY,
      width: Math.max(maxX - minX, 40),
      height: Math.max(maxY - minY, 40)
    };
  }

  return null;
}

function applyMarkers(
  canvas: CanvasLike,
  elementRegistry: ElementRegistryLike,
  markers: Record<string, string[]>,
  activeElementId?: string | null
) {
  const allElements = elementRegistry.getAll();

  for (const element of allElements) {
    for (const markerClass of MARKER_CLASSES) {
      canvas.removeMarker(element, markerClass);
    }
  }

  for (const [id, markerClasses] of Object.entries(markers)) {
    const element = elementRegistry.get(id);
    if (!element) {
      continue;
    }

    for (const markerClass of markerClasses) {
      canvas.addMarker(element, markerClass);
    }
  }

  if (activeElementId) {
    const activeElement = elementRegistry.get(activeElementId);
    if (activeElement) {
      canvas.addMarker(activeElement, 'merge-active');
    }
  }
}

function pulseElement(viewer: BpmnViewer | null, id: string) {
  if (!viewer) {
    return;
  }

  const canvas = viewer.get('canvas') as CanvasLike;
  const elementRegistry = viewer.get('elementRegistry') as ElementRegistryLike;
  const element = elementRegistry.get(id);

  if (!element) {
    return;
  }

  canvas.removeMarker(element, 'merge-pulse');
  window.requestAnimationFrame(() => {
    canvas.addMarker(element, 'merge-pulse');

    window.setTimeout(() => {
      canvas.removeMarker(element, 'merge-pulse');
    }, 900);
  });
}
