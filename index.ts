import { cursorTo } from 'readline';
import express from 'express';
import { watch } from 'chokidar';
import multer from 'multer';
import { match } from 'path-to-regexp';
import { merge } from 'webpack-merge';
import { mock } from 'mock-json-schema';
import http from 'http';
import { transformFileSync } from '@swc/core';
import type { Application } from 'express';
import type { FSWatcher } from 'chokidar';
import type { RequestHandler } from 'serve-static';
import type { Options } from '@swc/core';
import type { Request, Response, NextFunction } from 'express';

export interface RequestFormData extends Request {
  files: Express.Multer.File[];
}
export type ProxyFuncType = (req: RequestFormData, res: Response, next: NextFunction) => void;
export type YApiMockOption = {
  /** YApi host */
  host: string;
  /** 接口id */
  id: string;
  /** YApi开放接口token */
  token: string;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MockConfiguration = Record<string, ProxyFuncType | Record<string, any> | null>;

const swcOption: Options = {
  inputSourceMap: false,
  sourceMaps: false,
  module: {
    type: 'commonjs',
  },
  jsc: {
    parser: {
      syntax: 'typescript',
    },
    loose: false,
  },
};

export const tfc = (filepath: string) => {
  const out = transformFileSync(filepath, swcOption).code || '{}';

  try {
    return eval(out);
  } catch (error) {
    return out;
  }
};

const multipart = multer();
const oldMock: MockConfiguration = {};

let proxy: MockConfiguration = {},
  watcher: FSWatcher;

// 清除mock文件对应的数据
function clearProxy(iproxy: MockConfiguration, path: string, old: MockConfiguration) {
  if (old[path]) {
    for (const key in old[path]) {
      if (Object.prototype.hasOwnProperty.call(old[path], key)) {
        delete iproxy[key];
      }
    }
    old[path] = null;
    delete old[path];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const yApiMock = <T = any>(option: YApiMockOption, data?: T) => {
  return new Promise<T>((res, rej) => {
    http.get(`${option.host}/api/interface/get?id=${option.id}&token=${option.token}`, (resp) => {
      resp.setEncoding('utf8');
      let rawData = '';

      resp.on('data', (chunk) => {
        rawData += chunk;
      });
      resp.on('end', () => {
        try {
          const parsedData = JSON.parse(rawData);

          if (parsedData?.data?.res_body_is_json_schema) {
            const schema = JSON.parse(parsedData.data.res_body);
            const mockData = mock(schema);

            if (typeof data !== 'undefined') {
              res(merge(mockData, data));
            } else {
              res(mockData);
            }
          }
        } catch (error) {
          rej(error);
        }
      });
    });
  });
};

export default function (app: Application, watchFile?: string): ProxyFuncType {
  if (!watchFile) {
    throw new Error('mock配置不存在!');
  }
  if (!proxy) {
    return function (_req, _res, next) {
      next();
    };
  }
  // 配置热更新,监听文件修改重新加载代码
  if (!watcher) {
    // 监听配置入口文件所在的目录
    watcher = watch(watchFile);
    watcher.on('all', function (event, path) {
      process.stdout.write('update mock...');
      let np = {};

      switch (event) {
        case 'add':
        case 'change':
          clearProxy(proxy, path, oldMock);
          np = eval(tfc(path)).default;

          oldMock[path] = np;
          proxy = Object.assign(proxy, np);
          break;
        case 'unlink':
          clearProxy(proxy, path, oldMock);
          break;
        default:
          break;
      }
      cursorTo(process.stdout, 0);
      process.stdout.write('update mock success');
    });
  }

  app.all('/*', multipart.any(), function (req, res, next) {
    const proxyURL = `${req.method} ${req.path}`;
    // 判断下面这种路由
    // => GET /monako_api/:id/:page
    const containMockURL = Object.keys(proxy).filter(function (kname) {
      return new RegExp('^' + kname.replace(/(:\w*)[^/]/g, '((?!/).)') + '*$').test(proxyURL);
    });

    if (proxy[proxyURL] || (containMockURL && containMockURL.length > 0)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let bodyParserMethd: RequestHandler<express.Response<any, Record<string, any>>>;
      const contentType: string | undefined = req.get('Content-Type');

      switch (contentType) {
        case 'text/plain':
          bodyParserMethd = express.raw({ type: 'text/plain' });
          break;
        case 'text/html':
          bodyParserMethd = express.text({ type: 'text/html' });
          break;
        case 'application/x-www-form-urlencoded':
          bodyParserMethd = express.urlencoded({ extended: false });
          break;
        default:
          bodyParserMethd = express.json();
          break;
      }
      if (contentType?.startsWith('multipart/form-data;')) {
        bodyParserMethd = express.static('./public');
      }

      bodyParserMethd(req, res, function () {
        const result = proxy[proxyURL] || proxy[containMockURL[0]];

        if (typeof result === 'function') {
          const resfulApi = match(containMockURL[0].split(' ')[1])(req.url);

          if (resfulApi) {
            Object.assign(req.params, resfulApi.params);
          }
          result(req as unknown as RequestFormData, res, next);
        } else {
          res.json(result);
        }
      });
    } else {
      return next();
    }
  });

  return function (_req, _res, next) {
    next();
  };
}
