/** 模型明确返回 length 终止时的业务错误，避免把只有思考的输出误报为调用失败。 */
export class ModelOutputLimitError extends Error {
  constructor() {
    super(
      '模型达到单次输出上限，回复尚未完成。思考也占用输出预算，请在模型设置中提高最大输出，或设为 0 跟随服务商默认值。',
    );
  }
}
