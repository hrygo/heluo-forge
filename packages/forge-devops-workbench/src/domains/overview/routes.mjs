/**
 * 总览域同源 HTTP 路由表：`/summary` 与 `/itsm/open-url`。
 */

/**
 * 声明总览域路由。
 *
 * @param {{ getSummary: Function, resolveItsmPortalUrl: Function }} service
 */
export function createOverviewRoutes(service) {
  return [
    {
      path: '/summary',
      methods: ['GET', 'HEAD'],
      allow: 'GET',
      async handler({ params }) {
        return service.getSummary({
          reqView: params?.get('reqView') || 'manager',
          implView: params?.get('implView') || 'responsible',
          projView: params?.get('projView') || 'responsible',
          refresh: params?.get('refresh') === '1' || params?.get('refresh') === 'true',
        });
      },
    },
    {
      path: '/itsm/open-url',
      methods: ['GET', 'HEAD'],
      allow: 'GET',
      async handler({ params }) {
        return service.resolveItsmPortalUrl({ wjbiid: params?.get('wjbiid') || '' });
      },
    },
  ];
}
