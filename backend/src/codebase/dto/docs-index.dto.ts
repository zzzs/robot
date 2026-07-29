import { IsString, IsNotEmpty } from 'class-validator';

/** POST /api/docs/index — 索引单个本地 .md 文件 */
export class DocIndexDto {
  /** 绝对路径,如 /Users/.../my-doc.md */
  @IsString()
  @IsNotEmpty()
  source!: string;

  /** 项目名(用于多项目区分) */
  @IsString()
  @IsNotEmpty()
  name!: string;
}
